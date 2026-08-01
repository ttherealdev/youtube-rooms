//! Automatic advance when a video finishes.
//!
//! Driven **server-side**, not by the host's player. Relying on the host to
//! report "the video ended" means the room stalls the moment they close their
//! tab, lose focus, or hit a rebuffer — and the whole point of a server-owned
//! timeline is that we already know exactly when the video ends without asking
//! anyone (ADR 0005).
//!
//! Only the node holding a room's lease advances it, so two nodes cannot skip
//! the same video twice.

use crate::{
    db,
    realtime::{
        protocol::{TimelineReason, system_author},
        session::{AdvanceRequest, Session},
    },
    rooms::permissions::Role,
    state::AppState,
    util,
};
use std::time::Duration;
use tokio::sync::mpsc;

/// One second is well inside the perceptual gap between videos and cheap: the
/// check is a lock and a subtraction per owned room.
const TICK: Duration = Duration::from_secs(1);

/// How long a cued source waits for someone to report they can play it before
/// the room starts anyway.
///
/// The hold exists so a big file is not skipped before anyone can see it; this
/// bound exists so the opposite failure is impossible. A source nobody can play
/// — a dead link, a codec no one has — would otherwise leave the room parked on
/// it forever with no way forward, since auto-advance only fires on a timeline
/// that is running.
const START_TIMEOUT_MS: i64 = 20_000;

pub async fn run(state: AppState) {
    let mut ticker = tokio::time::interval(TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        if let Err(error) = sweep(&state).await {
            tracing::warn!(?error, "auto-advance sweep failed");
        }
    }
}

async fn sweep(state: &AppState) -> anyhow::Result<()> {
    let now = util::now_ms();

    for room_id in state.hub.owned_rooms() {
        let Some(room) = state.hub.get(room_id) else {
            continue;
        };

        // Skip empty rooms: advancing a queue nobody is watching burns
        // database writes and consumes the queue before people return.
        if room.participant_count().await == 0 {
            continue;
        }

        // Release a cue that nobody answered, before anything else looks at
        // whether the video has ended — a held timeline is paused, so every
        // check below would otherwise skip it in perpetuity.
        let released = {
            let mut state_guard = room.state.lock().await;
            match state_guard.timeline.as_mut() {
                Some(timeline) if timeline.start_overdue(now, START_TIMEOUT_MS) => {
                    timeline.start_playback(now)
                }
                _ => false,
            }
        };

        if released {
            tracing::debug!(room = %room_id, "no player reported ready; starting anyway");
            broadcast_current(state, &room).await;
            continue;
        }

        let (ended, looping, live) = {
            let state_guard = room.state.lock().await;
            match state_guard.timeline.as_ref() {
                Some(timeline) => (
                    timeline.has_ended(now),
                    timeline.loop_current,
                    timeline
                        .source
                        .as_ref()
                        .is_some_and(|source| source.kind.may_be_live()),
                ),
                None => (false, false, false),
            }
        };

        // A live stream has no end to reach. In practice its duration is never
        // known — a browser reports `Infinity`, which `set_duration` refuses —
        // so `has_ended` is already false. Checking the kind directly means
        // this does not quietly depend on that coincidence: one client
        // reporting a bogus finite duration would otherwise skip the channel
        // everyone is watching.
        if live {
            continue;
        }

        if !ended {
            continue;
        }

        let settings = room.info.read().await.settings.clone();

        // Loop wins over advance: the host asked for this video to repeat.
        if looping {
            let mut guard = room.state.lock().await;
            if let Some(timeline) = guard.timeline.as_mut() {
                timeline.restart(now);
            }
            drop(guard);

            broadcast_current(state, &room).await;
            continue;
        }

        if !settings.auto_advance {
            // Pause on the final frame rather than leaving a timeline that
            // reports "ended" forever and re-triggers this sweep every tick.
            let mut guard = room.state.lock().await;
            if let Some(timeline) = guard.timeline.as_mut() {
                timeline.pause(now);
            }
            drop(guard);

            broadcast_current(state, &room).await;
            continue;
        }

        system_session(state, &room)
            .advance(AdvanceRequest::Next, TimelineReason::Advance)
            .await
            .ok();
    }

    Ok(())
}

/// A `Session` with no socket behind it, used to reuse the authoritative
/// mutation paths from a background task. Replies go nowhere, which is correct:
/// there is no client to reply to.
fn system_session(state: &AppState, room: &std::sync::Arc<crate::realtime::room::Room>) -> Session {
    let (out, rx) = mpsc::channel(1);
    drop(rx);

    Session {
        state: state.clone(),
        room: std::sync::Arc::clone(room),
        user: system_author(),
        role: Role::Host,
        permissions: crate::rooms::permissions::resolve(
            Role::Host,
            &crate::db::rooms::RoomSettings::default(),
        ),
        out,
    }
}

async fn broadcast_current(state: &AppState, room: &std::sync::Arc<crate::realtime::room::Room>) {
    let timeline = { room.state.lock().await.timeline.clone() };
    let Some(timeline) = timeline else { return };

    state.hub.persist_timeline(room.id, &timeline).await;
    state
        .hub
        .broadcast(
            room,
            &crate::realtime::protocol::ServerMessage::Timeline {
                timeline,
                actor: None,
                reason: TimelineReason::Advance,
            },
        )
        .await;

    // Keep the directory's activity timestamp fresh for long sessions.
    let count = room.participant_count().await as i32;
    let _ = db::rooms::touch_activity(&state.db, room.id, count).await;
}
