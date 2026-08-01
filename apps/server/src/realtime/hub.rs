//! The room registry and cross-node fan-out.
//!
//! Implements ADR 0010: sockets may land on any node, but exactly one node owns
//! a room's authoritative timeline at a time, decided by a Redis lease. Nodes
//! that do not own a room still serve its sockets — they relay broadcasts from
//! Redis and forward mutating intents to the owner.

use crate::{
    cache::{self, Redis},
    config::Config,
    db,
    realtime::{
        protocol::{RoomInfo, ServerMessage},
        room::Room,
    },
    sync::Timeline,
    util,
};
use dashmap::DashMap;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

/// Wrapper for anything crossing the Redis channel, so a node can ignore its
/// own publications instead of echoing them back to its own sockets.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    origin: String,
    /// Pre-encoded `ServerMessage` JSON. Kept as a string so relaying nodes
    /// never deserialize and re-serialize a message they only pass through.
    payload: String,
}

/// A mutating intent forwarded to whichever node owns the room.
#[derive(Debug, Serialize, Deserialize)]
pub struct ForwardedIntent {
    pub origin: String,
    pub room_id: Uuid,
    pub actor_id: Uuid,
    /// Serialized `ClientMessage`. Permission was already checked on the
    /// originating node, which is the one with the actor's membership loaded.
    pub message: String,
}

pub struct Hub {
    /// Stable per-process identity, used for lease ownership.
    pub node_id: String,
    rooms: DashMap<Uuid, Arc<Room>>,
    /// Rooms whose lease this node currently holds.
    owned: DashMap<Uuid, ()>,
    config: Arc<Config>,
    db: PgPool,
    redis: Redis,
}

impl Hub {
    pub fn new(config: Arc<Config>, db: PgPool, redis: Redis) -> Self {
        Self {
            node_id: format!("node-{}", util::random_token(8)),
            rooms: DashMap::new(),
            owned: DashMap::new(),
            config,
            db,
            redis,
        }
    }

    pub fn get(&self, room_id: Uuid) -> Option<Arc<Room>> {
        self.rooms.get(&room_id).map(|entry| Arc::clone(&entry))
    }

    pub fn active_room_count(&self) -> usize {
        self.rooms.len()
    }

    pub fn owned_room_count(&self) -> usize {
        self.owned.len()
    }

    /// Snapshot of the rooms this node is authoritative for.
    pub fn owned_rooms(&self) -> Vec<Uuid> {
        self.owned.iter().map(|entry| *entry.key()).collect()
    }

    /// Fetch or construct the runtime for a room.
    ///
    /// On first construction this node attempts to claim the lease and, if it
    /// wins, restores the timeline from Redis so a failover does not reset
    /// playback to the beginning.
    pub async fn get_or_create(&self, room_id: Uuid) -> anyhow::Result<Arc<Room>> {
        if let Some(existing) = self.get(room_id) {
            return Ok(existing);
        }

        let record = db::rooms::find_by_id(&self.db, room_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("room {room_id} does not exist"))?;

        let info = RoomInfo {
            id: record.id,
            slug: record.slug.clone(),
            name: record.name.clone(),
            topic: record.topic.clone(),
            visibility: record.visibility.clone(),
            category: record.category.clone(),
            host_id: record.host_id,
            owner_id: record.owner_id,
            successor_id: record.successor_id,
            created_at: record.created_at.timestamp_millis(),
            max_participants: record.max_participants,
            settings: record.settings.0.clone(),
        };

        let room = Arc::new(Room::new(info, self.config.realtime.send_buffer));

        // Another task may have created it while we were querying.
        let room = match self.rooms.entry(room_id) {
            dashmap::mapref::entry::Entry::Occupied(entry) => Arc::clone(entry.get()),
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                entry.insert(Arc::clone(&room));
                room
            }
        };

        if self.try_claim(room_id).await {
            let restored = self.restore_timeline(room_id).await;
            let mut state = room.state.lock().await;
            state.timeline = Some(restored.unwrap_or_else(|| Timeline::idle(util::now_ms())));
        }

        Ok(room)
    }

    /// Does this node hold the room's lease?
    pub fn owns(&self, room_id: Uuid) -> bool {
        self.owned.contains_key(&room_id)
    }

    /// Attempt to take (or renew) ownership.
    pub async fn try_claim(&self, room_id: Uuid) -> bool {
        let mut redis = self.redis.clone();
        match cache::claim_room_lease(
            &mut redis,
            &room_id,
            &self.node_id,
            self.config.realtime.room_lease_ttl,
        )
        .await
        {
            Ok(true) => {
                self.owned.insert(room_id, ());
                true
            }
            Ok(false) => {
                self.owned.remove(&room_id);
                false
            }
            Err(error) => {
                // Redis is down. Rather than freeze every room, fall back to
                // local ownership: a split brain across nodes is worse than a
                // brief single-node authority, and single-node is the common
                // deployment.
                tracing::warn!(?error, %room_id, "lease check failed; assuming local ownership");
                self.owned.insert(room_id, ());
                true
            }
        }
    }

    /// Publish a message to every node that has listeners for this room, and to
    /// this node's own sockets.
    pub async fn broadcast(&self, room: &Room, message: &ServerMessage) {
        let Some(encoded) = room.broadcast_local(message) else {
            return;
        };

        let envelope = Envelope {
            origin: self.node_id.clone(),
            payload: encoded.to_string(),
        };

        let Ok(serialized) = serde_json::to_string(&envelope) else {
            return;
        };

        let mut redis = self.redis.clone();
        let channel = cache::keys::room_channel(&room.id);
        let result: Result<(), _> = redis::cmd("PUBLISH")
            .arg(&channel)
            .arg(serialized)
            .query_async::<()>(&mut redis)
            .await;

        if let Err(error) = result {
            // Local subscribers already have the message; only other nodes miss
            // it, and their clients recover on the next snapshot.
            tracing::warn!(?error, %channel, "failed to publish to Redis");
        }
    }

    /// Send a mutating intent to the node that owns the room.
    pub async fn forward_intent(&self, room_id: Uuid, actor_id: Uuid, message: &str) {
        let intent = ForwardedIntent {
            origin: self.node_id.clone(),
            room_id,
            actor_id,
            message: message.to_owned(),
        };

        let Ok(serialized) = serde_json::to_string(&intent) else {
            return;
        };

        let mut redis = self.redis.clone();
        let channel = format!("ytr:room:{room_id}:intents");
        let result: Result<(), _> = redis::cmd("PUBLISH")
            .arg(&channel)
            .arg(serialized)
            .query_async::<()>(&mut redis)
            .await;

        if let Err(error) = result {
            tracing::warn!(?error, %room_id, "failed to forward intent to room owner");
        }
    }

    /// Mirror the authoritative timeline so a new owner can pick up where the
    /// old one left off.
    pub async fn persist_timeline(&self, room_id: Uuid, timeline: &Timeline) {
        let mut redis = self.redis.clone();
        let result = cache::set_json(
            &mut redis,
            &cache::keys::room_timeline(&room_id),
            timeline,
            std::time::Duration::from_secs(60 * 60 * 6),
        )
        .await;

        if let Err(error) = result {
            tracing::warn!(?error, %room_id, "failed to mirror timeline to Redis");
        }
    }

    async fn restore_timeline(&self, room_id: Uuid) -> Option<Timeline> {
        let mut redis = self.redis.clone();
        match cache::get_json::<Timeline>(&mut redis, &cache::keys::room_timeline(&room_id)).await {
            Ok(Some(timeline)) => {
                tracing::info!(%room_id, version = timeline.version, "restored timeline");
                Some(timeline)
            }
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(?error, %room_id, "could not restore timeline");
                None
            }
        }
    }

    /// Tear down a room with no remaining local listeners.
    pub async fn release(&self, room_id: Uuid) {
        let Some(room) = self.get(room_id) else { return };

        if room.local_listeners() > 0 || room.participant_count().await > 0 {
            return;
        }

        self.rooms.remove(&room_id);

        if self.owned.remove(&room_id).is_some() {
            let mut redis = self.redis.clone();
            if let Err(error) =
                cache::release_room_lease(&mut redis, &room_id, &self.node_id).await
            {
                tracing::warn!(?error, %room_id, "failed to release lease");
            }
        }

        tracing::debug!(%room_id, "room torn down");
    }

    /// Renew every lease we hold. Driven by a background ticker.
    pub async fn renew_leases(&self) {
        let owned = self.owned_rooms();
        for room_id in owned {
            if !self.try_claim(room_id).await {
                tracing::warn!(%room_id, "lost room lease to another node");
            }
        }
    }

    /// Release everything during a graceful drain, so a restarting node's rooms
    /// are claimable immediately rather than after the lease TTL.
    pub async fn drain(&self) {
        let owned = self.owned_rooms();
        let mut redis = self.redis.clone();

        for room_id in owned {
            if let Some(room) = self.get(room_id) {
                let state = room.state.lock().await;
                if let Some(timeline) = &state.timeline {
                    let _ = cache::set_json(
                        &mut redis,
                        &cache::keys::room_timeline(&room_id),
                        timeline,
                        std::time::Duration::from_secs(60 * 60 * 6),
                    )
                    .await;
                }
            }
            let _ = cache::release_room_lease(&mut redis, &room_id, &self.node_id).await;
        }

        tracing::info!(node = %self.node_id, "released all room leases");
    }
}

/// Subscribe to every room channel and relay to local sockets.
///
/// One pattern subscription for the whole process rather than one per room:
/// rooms come and go constantly, and re-subscribing per room would thrash the
/// connection.
pub async fn run_broadcast_relay(hub: Arc<Hub>, redis_url: String) {
    loop {
        match relay_once(&hub, &redis_url).await {
            Ok(()) => tracing::warn!("Redis relay ended; reconnecting"),
            Err(error) => tracing::error!(?error, "Redis relay failed; reconnecting"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn relay_once(hub: &Arc<Hub>, redis_url: &str) -> anyhow::Result<()> {
    let mut pubsub = cache::pubsub_connection(redis_url).await?;
    pubsub.psubscribe("ytr:room:*:events").await?;
    tracing::info!("subscribed to room broadcast channels");

    let mut stream = pubsub.on_message();
    while let Some(message) = stream.next().await {
        let Ok(raw) = message.get_payload::<String>() else {
            continue;
        };
        let Ok(envelope) = serde_json::from_str::<Envelope>(&raw) else {
            continue;
        };

        // Our own publication, already delivered locally.
        if envelope.origin == hub.node_id {
            continue;
        }

        let Some(room_id) = room_id_from_channel(message.get_channel_name()) else {
            continue;
        };

        if let Some(room) = hub.get(room_id) {
            room.deliver_encoded(Arc::from(envelope.payload.as_str()));
        }
    }

    Ok(())
}

/// Extract the room id from `ytr:room:{uuid}:events`.
fn room_id_from_channel(channel: &str) -> Option<Uuid> {
    channel
        .strip_prefix("ytr:room:")
        .and_then(|rest| rest.strip_suffix(":events"))
        .and_then(|id| Uuid::parse_str(id).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_room_ids_out_of_channel_names() {
        let id = Uuid::now_v7();
        assert_eq!(
            room_id_from_channel(&format!("ytr:room:{id}:events")),
            Some(id)
        );
    }

    #[test]
    fn rejects_malformed_channel_names() {
        assert!(room_id_from_channel("ytr:room:not-a-uuid:events").is_none());
        assert!(room_id_from_channel("ytr:room:events").is_none());
        assert!(room_id_from_channel("something:else").is_none());
    }

    #[test]
    fn envelopes_round_trip() {
        let envelope = Envelope {
            origin: "node-abc".into(),
            payload: r#"{"t":"pong"}"#.into(),
        };
        let json = serde_json::to_string(&envelope).unwrap();
        let parsed: Envelope = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.origin, "node-abc");
        assert_eq!(parsed.payload, r#"{"t":"pong"}"#);
    }
}
