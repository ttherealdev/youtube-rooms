//! Who runs the room, and when the room stops existing.
//!
//! Three rules, and they interact:
//!
//!   * **A room always has a host.** When the host's last connection drops,
//!     the room promotes someone still present rather than becoming an
//!     ungoverned space nobody can moderate or reconfigure.
//!   * **A creator keeps their room.** An automatic promotion is custody, not
//!     ownership, so the creator reclaims the room the moment they come back.
//!   * **An empty room closes.** After a grace period, so that a refresh, a
//!     flaky connection or a quick tab reload does not destroy it.
//!
//! The decisions are pure functions here; the writes live in the socket
//! lifecycle. That split is what makes the succession order testable without a
//! database, and it is the part most likely to be quietly wrong.

use crate::{
    db,
    realtime::protocol::{KickReason, ServerMessage},
    rooms::permissions::{Role, succession_key},
    state::AppState,
};
use uuid::Uuid;

/// One candidate to inherit the room.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Candidate {
    pub user_id: Uuid,
    pub role: Role,
    /// Server clock at which they joined. Ties break towards whoever has been
    /// here longest.
    pub joined_at: i64,
}

/// Pick the next host when `departing` leaves.
///
/// The nomination wins if that person is actually still in the room — a
/// successor who left before the host is a name, not a plan. Otherwise the
/// room falls through co-hosts, then members, then guests, preferring whoever
/// has been present longest.
///
/// Returns `None` when nobody is left, which is the signal to start the
/// empty-room clock rather than to promote anyone.
pub fn choose_successor(
    candidates: &[Candidate],
    departing: Uuid,
    nominated: Option<Uuid>,
) -> Option<Uuid> {
    let eligible: Vec<&Candidate> = candidates
        .iter()
        .filter(|candidate| candidate.user_id != departing)
        .collect();

    if eligible.is_empty() {
        return None;
    }

    if let Some(nominated) = nominated
        && eligible.iter().any(|c| c.user_id == nominated)
    {
        return Some(nominated);
    }

    eligible
        .iter()
        .min_by_key(|c| succession_key(c.role, c.joined_at))
        .map(|c| c.user_id)
}

/// Should `joining` be handed the room back on arrival?
///
/// Only the recorded owner, only when someone else currently holds it. An
/// explicit transfer moves `owner_id` too, so a host who deliberately gave the
/// room away does not take it back by walking in.
pub fn should_reclaim(owner_id: Option<Uuid>, current_host: Uuid, joining: Uuid) -> bool {
    owner_id == Some(joining) && current_host != joining
}

/// Run the empty-room sweep forever.
///
/// A background sweep rather than a per-room timer, because the timer would
/// live on whichever node happened to see the last disconnect — and that node
/// restarting, or the room's participants being spread across several nodes,
/// would silently leave the room open forever. A sweep over the table is
/// stateless and correct regardless of which node runs it.
pub fn spawn_sweeper(state: AppState) {
    let grace = state.config.realtime.empty_room_grace;
    let interval = state.config.realtime.empty_room_sweep;

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;

            let closed = match db::rooms::close_expired_empty_rooms(&state.db, grace).await {
                Ok(closed) => closed,
                Err(error) => {
                    // A failed sweep is not fatal — the next tick retries, and
                    // the rooms stay reachable in the meantime.
                    tracing::error!(?error, "empty-room sweep failed");
                    continue;
                }
            };

            for room_id in closed {
                tracing::info!(%room_id, "closed an empty room");

                db::history::audit(
                    &state.db,
                    None,
                    Some(room_id),
                    "room.closed_empty",
                    serde_json::json!({ "graceSeconds": grace.as_secs() }),
                )
                .await;

                // A late arrival can still hold a socket on a room the sweep
                // just closed — tell them why rather than letting the UI show a
                // generic disconnect.
                if let Some(live) = state.hub.get(room_id) {
                    state
                        .hub
                        .broadcast(
                            &live,
                            &ServerMessage::Kicked {
                                reason: KickReason::RoomClosed,
                            },
                        )
                        .await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> Uuid {
        Uuid::from_bytes([n; 16])
    }

    fn candidate(n: u8, role: Role, joined_at: i64) -> Candidate {
        Candidate {
            user_id: id(n),
            role,
            joined_at,
        }
    }

    #[test]
    fn an_empty_room_promotes_nobody() {
        assert_eq!(choose_successor(&[], id(1), None), None);
    }

    #[test]
    fn a_room_containing_only_the_departing_host_promotes_nobody() {
        let room = [candidate(1, Role::Host, 0)];
        assert_eq!(choose_successor(&room, id(1), None), None);
    }

    #[test]
    fn a_cohost_inherits_before_a_member() {
        let room = [
            candidate(1, Role::Host, 0),
            candidate(2, Role::Member, 10),
            candidate(3, Role::Cohost, 50),
        ];
        assert_eq!(choose_successor(&room, id(1), None), Some(id(3)));
    }

    #[test]
    fn within_a_rank_the_longest_present_inherits() {
        let room = [
            candidate(1, Role::Host, 0),
            candidate(2, Role::Cohost, 300),
            candidate(3, Role::Cohost, 100),
        ];
        assert_eq!(choose_successor(&room, id(1), None), Some(id(3)));
    }

    #[test]
    fn a_guest_inherits_rather_than_leaving_the_room_hostless() {
        // An ungoverned room is worse than a guest host: nobody could skip a
        // stuck video, moderate chat, or change a setting.
        let room = [candidate(1, Role::Host, 0), candidate(2, Role::Guest, 10)];
        assert_eq!(choose_successor(&room, id(1), None), Some(id(2)));
    }

    #[test]
    fn the_nomination_beats_the_default_order() {
        let room = [
            candidate(1, Role::Host, 0),
            candidate(2, Role::Cohost, 10),
            candidate(3, Role::Member, 20),
        ];
        // The member is nominated, so they inherit ahead of the co-host.
        assert_eq!(choose_successor(&room, id(1), Some(id(3))), Some(id(3)));
    }

    #[test]
    fn a_nomination_for_someone_who_already_left_falls_back_to_the_order() {
        let room = [
            candidate(1, Role::Host, 0),
            candidate(2, Role::Cohost, 10),
        ];
        // id(9) is not in the room; the co-host inherits instead of the room
        // being handed to nobody.
        assert_eq!(choose_successor(&room, id(1), Some(id(9))), Some(id(2)));
    }

    #[test]
    fn a_host_who_nominated_themselves_does_not_keep_the_room() {
        let room = [
            candidate(1, Role::Host, 0),
            candidate(2, Role::Member, 10),
        ];
        assert_eq!(choose_successor(&room, id(1), Some(id(1))), Some(id(2)));
    }

    #[test]
    fn the_owner_reclaims_a_room_someone_else_is_holding() {
        assert!(should_reclaim(Some(id(1)), id(2), id(1)));
    }

    #[test]
    fn the_owner_arriving_at_their_own_room_changes_nothing() {
        assert!(!should_reclaim(Some(id(1)), id(1), id(1)));
    }

    #[test]
    fn a_non_owner_never_reclaims() {
        assert!(!should_reclaim(Some(id(1)), id(2), id(3)));
        assert!(!should_reclaim(Some(id(1)), id(2), id(2)));
    }

    #[test]
    fn a_room_with_no_recorded_owner_is_never_reclaimed() {
        // Pre-migration rows, and rooms whose creator deleted their account.
        assert!(!should_reclaim(None, id(2), id(1)));
    }

    #[test]
    fn an_explicitly_transferred_room_is_not_taken_back() {
        // After an explicit transfer `owner_id` is the new host, so the
        // previous owner walking back in reclaims nothing.
        let new_owner = id(2);
        assert!(!should_reclaim(Some(new_owner), new_owner, id(1)));
    }
}
