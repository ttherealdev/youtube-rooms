//! The receiving half of cross-node intent forwarding (ADR 0010).
//!
//! A node that holds a socket but not the room's lease cannot mutate the
//! timeline — only one clock may decide (ADR 0005). It publishes the intent
//! here instead, and whichever node owns the lease applies it and broadcasts
//! the result back through the normal fan-out.
//!
//! ## Deliberate limitation
//!
//! Per-connection replies (a `stale_version` or `forbidden` error) are **not**
//! routed back to the originating socket — the owner has no channel to it. This
//! is acceptable because permissions are checked on the originating node before
//! forwarding, so a forwarded intent that fails is rare. The client's next
//! `timeline` broadcast reconciles it either way. Making replies routable would
//! mean a request/response channel per node pair, which is not worth it at this
//! scale.

use crate::{
    cache, db,
    realtime::{hub::ForwardedIntent, protocol::ClientMessage, session::Session},
    rooms::permissions::{self, Role},
    state::AppState,
};
use futures_util::StreamExt;
use tokio::sync::mpsc;

pub async fn run(state: AppState, redis_url: String) {
    loop {
        match subscribe_once(&state, &redis_url).await {
            Ok(()) => tracing::warn!("intent relay ended; reconnecting"),
            Err(error) => tracing::error!(?error, "intent relay failed; reconnecting"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn subscribe_once(state: &AppState, redis_url: &str) -> anyhow::Result<()> {
    let mut pubsub = cache::pubsub_connection(redis_url).await?;
    pubsub.psubscribe("ytr:room:*:intents").await?;
    tracing::info!("subscribed to room intent channels");

    let mut stream = pubsub.on_message();
    while let Some(message) = stream.next().await {
        let Ok(raw) = message.get_payload::<String>() else {
            continue;
        };
        let Ok(intent) = serde_json::from_str::<ForwardedIntent>(&raw) else {
            continue;
        };

        // Our own publication — we forwarded it precisely because we are *not*
        // the owner, so applying it here would defeat the point.
        if intent.origin == state.hub.node_id {
            continue;
        }

        // Only the lease holder applies.
        if !state.hub.owns(intent.room_id) {
            continue;
        }

        if let Err(error) = apply(state, intent).await {
            tracing::warn!(?error, "failed to apply forwarded intent");
        }
    }

    Ok(())
}

async fn apply(state: &AppState, intent: ForwardedIntent) -> anyhow::Result<()> {
    let Some(room) = state.hub.get(intent.room_id) else {
        return Ok(());
    };

    let parsed: ClientMessage = serde_json::from_str(&intent.message)?;

    let Some(user) = db::users::find_by_id(&state.db, intent.actor_id).await? else {
        return Ok(());
    };

    let Some(record) = db::rooms::find_by_id(&state.db, intent.room_id).await? else {
        return Ok(());
    };

    // Re-check authorisation here rather than trusting the forwarding node.
    // Both nodes are ours, but defence in depth costs one query and removes a
    // whole class of "compromised node" reasoning.
    let membership = db::rooms::find_membership(&state.db, intent.room_id, user.id).await?;
    if membership.as_ref().and_then(|m| m.banned_at).is_some() {
        return Ok(());
    }

    let role = membership
        .as_ref()
        .map(|m| Role::parse(&m.role))
        .unwrap_or(if user.kind == "guest" {
            Role::Guest
        } else {
            Role::Member
        });

    // Replies have nowhere to go; the receiver is dropped immediately and the
    // bounded sender simply fails, which `Session::reply` already tolerates.
    let (out, rx) = mpsc::channel(1);
    drop(rx);

    let mut session = Session {
        state: state.clone(),
        room,
        user: db::users::UserSummary::from(&user),
        role,
        permissions: permissions::resolve(role, &record.settings.0),
        out,
    };

    session.handle(parsed).await;
    Ok(())
}
