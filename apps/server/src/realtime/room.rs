//! Per-room runtime state and fan-out.
//!
//! One `Room` exists per active room on each node that has listeners for it.
//! It holds the participant set, the vote tally, and — on the node that owns
//! the room's lease — the authoritative `Timeline`.
//!
//! ## Serialize once, send many
//!
//! Broadcasts are serialized to JSON **once** and shared as an `Arc<str>`. In a
//! 40-person room the naive alternative does 40 identical `serde_json`
//! serializations per event; this does one. It is the single highest-leverage
//! optimisation in the realtime path.

use crate::{
    db::users::UserSummary,
    realtime::protocol::{Participant, RoomInfo, ServerMessage},
    rooms::permissions::Role,
    sync::Timeline,
    util,
};
use std::collections::{HashMap, HashSet};
use tokio::sync::{Mutex, RwLock, broadcast};
use uuid::Uuid;

/// A single connected client's view of a participant.
#[derive(Debug, Clone)]
pub struct ParticipantState {
    pub user: UserSummary,
    pub role: Role,
    pub joined_at: i64,
    /// Same person, multiple tabs. Presence only ends when this reaches zero.
    pub connections: usize,
    pub in_voice: bool,
    pub muted: bool,
    pub drift_ms: Option<f64>,
}

impl ParticipantState {
    pub fn to_protocol(&self) -> Participant {
        Participant {
            user: self.user.clone(),
            role: self.role.as_str().to_string(),
            joined_at: self.joined_at,
            in_voice: self.in_voice,
            muted: self.muted,
            drift_ms: self.drift_ms,
        }
    }
}

#[derive(Debug, Default)]
pub struct RoomRuntime {
    pub timeline: Option<Timeline>,
    pub participants: HashMap<Uuid, ParticipantState>,
    pub skip_votes: HashSet<Uuid>,
    pub typing: HashSet<Uuid>,
}

impl RoomRuntime {
    /// Ratio-based threshold, floored at one vote so a two-person room can
    /// still skip, and excluding nobody — the host's vote counts the same.
    pub fn votes_needed(&self, ratio: f64) -> usize {
        let present = self.participants.len().max(1);
        ((present as f64 * ratio).ceil() as usize).max(1)
    }

    pub fn should_skip(&self, ratio: f64) -> bool {
        self.skip_votes.len() >= self.votes_needed(ratio)
    }

    pub fn voice_peers(&self) -> Vec<Uuid> {
        self.participants
            .iter()
            .filter(|(_, p)| p.in_voice)
            .map(|(id, _)| *id)
            .collect()
    }
}

pub struct Room {
    pub id: Uuid,
    pub info: RwLock<RoomInfo>,
    pub state: Mutex<RoomRuntime>,
    /// Local subscribers. Lagging receivers are dropped by the channel itself,
    /// which is the backpressure policy from ADR 0004.
    tx: broadcast::Sender<Arc<str>>,
}

use std::sync::Arc;

impl Room {
    pub fn new(info: RoomInfo, buffer: usize) -> Self {
        let (tx, _) = broadcast::channel(buffer);
        Self {
            id: info.id,
            info: RwLock::new(info),
            state: Mutex::new(RoomRuntime::default()),
            tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.tx.subscribe()
    }

    pub fn local_listeners(&self) -> usize {
        self.tx.receiver_count()
    }

    /// Serialize a message once and hand it to every local subscriber.
    ///
    /// Returns the encoded payload so the caller can also publish it to Redis
    /// for other nodes without re-serializing.
    pub fn broadcast_local(&self, message: &ServerMessage) -> Option<Arc<str>> {
        let encoded: Arc<str> = match serde_json::to_string(message) {
            Ok(json) => Arc::from(json.as_str()),
            Err(error) => {
                // A message we cannot serialize is a bug, not a runtime
                // condition — log loudly rather than silently dropping it.
                tracing::error!(?error, "failed to serialize server message");
                return None;
            }
        };

        // An error here only means nobody is listening on this node, which is
        // normal for a room whose participants are all on another node.
        let _ = self.tx.send(Arc::clone(&encoded));
        Some(encoded)
    }

    /// Relay an already-encoded payload that arrived from another node.
    pub fn deliver_encoded(&self, payload: Arc<str>) {
        let _ = self.tx.send(payload);
    }

    // -- Participants -------------------------------------------------------

    /// Register a connection. Returns `true` if this was the participant's
    /// first connection, i.e. the room should announce a join.
    pub async fn attach(&self, user: UserSummary, role: Role) -> bool {
        let mut state = self.state.lock().await;
        match state.participants.get_mut(&user.id) {
            Some(existing) => {
                existing.connections += 1;
                // Role may have changed since the previous tab connected.
                existing.role = role;
                false
            }
            None => {
                state.participants.insert(
                    user.id,
                    ParticipantState {
                        user,
                        role,
                        joined_at: util::now_ms(),
                        connections: 1,
                        in_voice: false,
                        muted: true,
                        drift_ms: None,
                    },
                );
                true
            }
        }
    }

    /// Drop a connection. Returns `true` when the participant's last connection
    /// closed and the room should announce a leave.
    pub async fn detach(&self, user_id: Uuid) -> bool {
        let mut state = self.state.lock().await;
        let Some(participant) = state.participants.get_mut(&user_id) else {
            return false;
        };

        participant.connections = participant.connections.saturating_sub(1);
        if participant.connections > 0 {
            return false;
        }

        state.participants.remove(&user_id);
        // Presence-derived state must not outlive the participant, or a vote
        // from someone who left keeps counting.
        state.skip_votes.remove(&user_id);
        state.typing.remove(&user_id);
        true
    }

    pub async fn participant_count(&self) -> usize {
        self.state.lock().await.participants.len()
    }

    pub async fn snapshot_participants(&self) -> Vec<Participant> {
        let state = self.state.lock().await;
        let mut list: Vec<Participant> =
            state.participants.values().map(|p| p.to_protocol()).collect();
        // Stable ordering so the participant list does not shuffle on re-render.
        list.sort_by_key(|p| p.joined_at);
        list
    }

    pub async fn role_of(&self, user_id: Uuid) -> Option<Role> {
        self.state
            .lock()
            .await
            .participants
            .get(&user_id)
            .map(|p| p.role)
    }

    /// Everyone currently present, as succession candidates.
    ///
    /// Deliberately built from live presence rather than the membership table:
    /// a room can only be inherited by someone who is actually in it, and the
    /// membership table is full of people who left hours ago.
    pub async fn succession_candidates(&self) -> Vec<crate::rooms::lifecycle::Candidate> {
        self.state
            .lock()
            .await
            .participants
            .values()
            .map(|p| crate::rooms::lifecycle::Candidate {
                user_id: p.user.id,
                role: p.role,
                joined_at: p.joined_at,
            })
            .collect()
    }

    /// Update a participant's role in the live set, returning the new
    /// protocol view so the caller can broadcast it.
    pub async fn set_role_local(&self, user_id: Uuid, role: Role) -> Option<Participant> {
        let mut state = self.state.lock().await;
        state.participants.get_mut(&user_id).map(|participant| {
            participant.role = role;
            participant.to_protocol()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::rooms::RoomSettings;

    fn user(n: u8) -> UserSummary {
        let id = Uuid::from_bytes([n; 16]);
        UserSummary {
            id,
            display_name: format!("User {n}"),
            avatar_url: None,
            initials: "U".into(),
            avatar_hue: 0,
            kind: "guest".into(),
        }
    }

    fn room() -> Room {
        Room::new(
            RoomInfo {
                id: Uuid::nil(),
                slug: "test-room-0000".into(),
                name: "Test".into(),
                topic: None,
                visibility: "public".into(),
                category: "general".into(),
                host_id: Uuid::nil(),
                owner_id: None,
                successor_id: None,
                created_at: 0,
                max_participants: 25,
                settings: RoomSettings::default(),
            },
            32,
        )
    }

    #[tokio::test]
    async fn first_connection_announces_a_join_and_extra_tabs_do_not() {
        let room = room();
        assert!(room.attach(user(1), Role::Member).await);
        assert!(!room.attach(user(1), Role::Member).await);
        assert_eq!(room.participant_count().await, 1);
    }

    #[tokio::test]
    async fn leaving_is_announced_only_when_the_last_tab_closes() {
        let room = room();
        room.attach(user(1), Role::Member).await;
        room.attach(user(1), Role::Member).await;

        assert!(!room.detach(user(1).id).await, "one tab remains");
        assert!(room.detach(user(1).id).await, "last tab closed");
        assert_eq!(room.participant_count().await, 0);
    }

    #[tokio::test]
    async fn detaching_an_unknown_user_is_a_no_op() {
        let room = room();
        assert!(!room.detach(Uuid::now_v7()).await);
    }

    #[tokio::test]
    async fn reconnecting_picks_up_the_current_role() {
        let room = room();
        room.attach(user(1), Role::Member).await;
        room.attach(user(1), Role::Cohost).await;
        assert_eq!(room.role_of(user(1).id).await, Some(Role::Cohost));
    }

    #[tokio::test]
    async fn leaving_clears_a_pending_skip_vote() {
        let room = room();
        room.attach(user(1), Role::Member).await;
        room.attach(user(2), Role::Member).await;

        room.state.lock().await.skip_votes.insert(user(1).id);
        room.detach(user(1).id).await;

        assert!(
            room.state.lock().await.skip_votes.is_empty(),
            "a vote must not outlive the voter"
        );
    }

    #[tokio::test]
    async fn vote_threshold_scales_with_the_room_and_floors_at_one() {
        let room = room();
        let mut state = room.state.lock().await;

        assert_eq!(state.votes_needed(0.5), 1, "empty room still needs one vote");

        for n in 1..=4 {
            state.participants.insert(
                user(n).id,
                ParticipantState {
                    user: user(n),
                    role: Role::Member,
                    joined_at: 0,
                    connections: 1,
                    in_voice: false,
                    muted: true,
                    drift_ms: None,
                },
            );
        }

        assert_eq!(state.votes_needed(0.5), 2);
        assert_eq!(state.votes_needed(0.75), 3);
        assert_eq!(state.votes_needed(1.0), 4);

        state.skip_votes.insert(user(1).id);
        assert!(!state.should_skip(0.5));
        state.skip_votes.insert(user(2).id);
        assert!(state.should_skip(0.5));
    }

    #[tokio::test]
    async fn participants_are_returned_in_join_order() {
        let room = room();
        room.attach(user(1), Role::Host).await;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        room.attach(user(2), Role::Member).await;

        let list = room.snapshot_participants().await;
        assert_eq!(list.len(), 2);
        assert!(list[0].joined_at <= list[1].joined_at);
    }

    #[tokio::test]
    async fn broadcast_encodes_once_and_reaches_every_local_subscriber() {
        let room = room();
        let mut a = room.subscribe();
        let mut b = room.subscribe();

        let encoded = room
            .broadcast_local(&ServerMessage::Pong {
                client_sent: 1.0,
                server_time: 2.0,
            })
            .expect("encodes");

        let got_a = a.try_recv().unwrap();
        let got_b = b.try_recv().unwrap();

        assert!(got_a.contains(r#""t":"pong""#));
        // Same allocation handed to both subscribers, not two copies.
        assert!(Arc::ptr_eq(&got_a, &got_b));
        assert!(Arc::ptr_eq(&got_a, &encoded));
    }

    #[tokio::test]
    async fn broadcasting_with_no_listeners_is_not_an_error() {
        let room = room();
        assert!(
            room.broadcast_local(&ServerMessage::Pong {
                client_sent: 0.0,
                server_time: 0.0
            })
            .is_some()
        );
    }

    #[tokio::test]
    async fn voice_peers_lists_only_those_in_the_call() {
        let room = room();
        room.attach(user(1), Role::Member).await;
        room.attach(user(2), Role::Member).await;

        {
            let mut state = room.state.lock().await;
            state.participants.get_mut(&user(1).id).unwrap().in_voice = true;
        }

        let peers = room.state.lock().await.voice_peers();
        assert_eq!(peers, vec![user(1).id]);
    }
}
