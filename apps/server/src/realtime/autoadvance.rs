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

        let (ended, looping) = {
            let state_guard = room.state.lock().await;
            match state_guard.timeline.as_ref() {
                Some(timeline) => (timeline.has_ended(now), timeline.loop_current),
                None => (false, false),
            }
        };

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
