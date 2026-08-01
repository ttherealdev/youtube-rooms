//! WebSocket lifecycle: handshake, pumps, heartbeat, teardown.

use crate::{
    cache, db,
    error::AppError,
    realtime::{
        protocol::{ChatEntry, ClientMessage, ErrorCode, ReadyPayload, ServerMessage, system_author},
        room::Room,
        session::{Session, ice_servers, touch_presence},
    },
    rooms::permissions::{self, Role},
    state::AppState,
    util,
};
use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, atomic::Ordering};
use tokio::sync::mpsc;
use uuid::Uuid;

pub async fn handler(
    State(state): State<AppState>,
    Path(room_id): Path<Uuid>,
    upgrade: WebSocketUpgrade,
) -> Response {
    // Frames are small; a large limit here would only help an attacker.
    upgrade
        .max_message_size(96 * 1024)
        .max_frame_size(96 * 1024)
        .on_upgrade(move |socket| run(socket, state, room_id))
}

async fn run(socket: WebSocket, state: AppState, room_id: Uuid) {
    state.metrics.ws_connections.fetch_add(1, Ordering::Relaxed);

    if let Err(error) = serve(socket, state.clone(), room_id).await {
        tracing::debug!(?error, %room_id, "socket closed");
    }

    state.metrics.ws_connections.fetch_sub(1, Ordering::Relaxed);
}

async fn serve(socket: WebSocket, state: AppState, room_id: Uuid) -> anyhow::Result<()> {
    let (mut sink, mut stream) = socket.split();

    // --- Handshake ---------------------------------------------------------
    // The first frame must be `authenticate`. Anything else, or silence past
    // the deadline, and the socket closes without ever reaching room state.
    let handshake = tokio::time::timeout(
        state.config.realtime.handshake_timeout,
        await_authentication(&mut stream),
    )
    .await;

    let ticket = match handshake {
        Ok(Ok(ticket)) => ticket,
        Ok(Err(reason)) => {
            tracing::debug!(%room_id, reason, "socket handshake rejected");
            close_with(&mut sink, ErrorCode::Unauthenticated, "Authentication required.").await;
            return Ok(());
        }
        Err(_elapsed) => {
            tracing::debug!(%room_id, "socket handshake timed out");
            close_with(&mut sink, ErrorCode::Unauthenticated, "Authentication timed out.").await;
            return Ok(());
        }
    };

    let Some(claims) = redeem_ticket(&state, &ticket, room_id).await else {
        let _ = sink
            .send(Message::Text(
                error_frame(ErrorCode::Unauthenticated, "That session has expired.").into(),
            ))
            .await;
        let _ = sink.close().await;
        return Ok(());
    };

    // --- Authorisation -----------------------------------------------------
    let Some(user) = db::users::find_by_id(&state.db, claims.user_id).await? else {
        return Ok(());
    };
    let summary = db::users::UserSummary::from(&user);

    let room_record = match db::rooms::find_by_id(&state.db, room_id).await? {
        Some(record) => record,
        None => {
            let _ = sink
                .send(Message::Text(
                    error_frame(ErrorCode::NotFound, "This room no longer exists.").into(),
                ))
                .await;
            return Ok(());
        }
    };

    let membership = db::rooms::find_membership(&state.db, room_id, user.id).await?;

    if membership.as_ref().and_then(|m| m.banned_at).is_some() {
        let _ = sink
            .send(Message::Text(
                serde_json::to_string(&ServerMessage::Kicked {
                    reason: crate::realtime::protocol::KickReason::Banned,
                })
                .unwrap_or_default()
                .into(),
            ))
            .await;
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

    let room = state.hub.get_or_create(room_id).await?;

    // Capacity is checked against live presence, not the membership table —
    // a room with 200 past members can still admit 25 people at once.
    if room.participant_count().await >= room_record.max_participants as usize {
        let _ = sink
            .send(Message::Text(
                error_frame(ErrorCode::RoomFull, "This room is full.").into(),
            ))
            .await;
        return Ok(());
    }

    // The creator is back. Reclaiming here — before the session exists — means
    // the snapshot they are about to receive already shows them as host, rather
    // than showing them as a member and correcting itself a moment later.
    let reclaimed = crate::rooms::lifecycle::should_reclaim(
        room_record.owner_id,
        room_record.host_id,
        user.id,
    );

    let role = if reclaimed {
        // Not permanent: this is the creator taking back custody, and their
        // ownership was never in question.
        db::rooms::transfer_host(&state.db, room_id, room_record.host_id, user.id, false).await?;

        let mut info = room.info.write().await;
        info.host_id = user.id;
        info.successor_id = None;
        drop(info);

        // Whoever was holding the room keeps co-host rather than being dropped
        // to member: they were trusted with the whole room a moment ago.
        room.set_role_local(room_record.host_id, Role::Cohost).await;

        Role::Host
    } else {
        role
    };

    let permissions = permissions::resolve(role, &room_record.settings.0);

    // --- Pumps -------------------------------------------------------------
    // Bounded so a client that stops reading cannot grow our memory; a full
    // queue closes the connection, and reconnect yields a fresh snapshot.
    let (out_tx, mut out_rx) = mpsc::channel::<Arc<str>>(state.config.realtime.send_buffer);
    let mut broadcast_rx = room.subscribe();

    let writer_state = state.clone();
    let heartbeat = state.config.realtime.heartbeat_interval;

    let writer = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(heartbeat);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                // Direct replies to this connection.
                Some(payload) = out_rx.recv() => {
                    if sink.send(Message::Text(payload.to_string().into())).await.is_err() {
                        break;
                    }
                    writer_state.metrics.ws_messages_out.fetch_add(1, Ordering::Relaxed);
                }

                // Room broadcasts.
                result = broadcast_rx.recv() => {
                    match result {
                        Ok(payload) => {
                            if sink.send(Message::Text(payload.to_string().into())).await.is_err() {
                                break;
                            }
                            writer_state.metrics.ws_messages_out.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            // This client could not keep up. Rather than send a
                            // partial history, drop it: reconnect delivers a
                            // complete snapshot (ADR 0004).
                            tracing::warn!(skipped, "slow client dropped");
                            writer_state
                                .metrics
                                .ws_dropped_slow_clients
                                .fetch_add(1, Ordering::Relaxed);
                            break;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }

                // Protocol-level keepalive. TCP keepalive notices a dead peer
                // far too late for presence to feel live.
                _ = ticker.tick() => {
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }

        let _ = sink.close().await;
    });

    // --- Join --------------------------------------------------------------
    let announced = room.attach(summary.clone(), role).await;

    db::rooms::upsert_membership(&state.db, room_id, user.id, role.as_str()).await?;

    let mut session = Session {
        state: state.clone(),
        room: Arc::clone(&room),
        user: summary.clone(),
        role,
        permissions,
        out: out_tx.clone(),
    };

    session.reply(&build_ready(&state, &room, &session).await?).await;

    if announced {
        let participant = {
            let state_guard = room.state.lock().await;
            state_guard.participants.get(&user.id).map(|p| p.to_protocol())
        };
        if let Some(participant) = participant {
            state
                .hub
                .broadcast(&room, &ServerMessage::ParticipantJoined { participant })
                .await;
        }
    }

    if reclaimed {
        // The person who was holding the room keeps co-host, but their
        // authority just shrank — tell them so, or they keep host-only controls
        // on screen that the server will now refuse.
        let settings = room.info.read().await.settings.clone();
        state
            .hub
            .broadcast(
                &room,
                &ServerMessage::PermissionsUpdated {
                    user_id: room_record.host_id,
                    role: Role::Cohost.as_str().to_string(),
                    permissions: permissions::resolve(Role::Cohost, &settings),
                },
            )
            .await;

        announce_host_change(
            &state,
            &room,
            &format!("{} is hosting again.", summary.display_name),
        )
        .await;
    }

    // Anyone present cancels the empty-room clock, so a room that briefly
    // emptied is not swept out from under the person who just walked in.
    let _ = db::rooms::set_emptiness(&state.db, room_id, false).await;

    {
        let mut redis = state.redis.clone();
        touch_presence(&mut redis, room_id, user.id).await;
    }

    // --- Read loop ---------------------------------------------------------
    // Liveness is enforced purely by the read timeout below: any frame,
    // including a transport pong, resets it.
    let client_timeout = state.config.realtime.client_timeout;

    loop {
        let next = tokio::time::timeout(client_timeout, stream.next()).await;

        let message = match next {
            Err(_) => {
                tracing::debug!(user = %user.id, "client timed out");
                break;
            }
            Ok(None) => break,
            Ok(Some(Err(error))) => {
                tracing::debug!(?error, "socket read error");
                break;
            }
            Ok(Some(Ok(message))) => message,
        };

        match message {
            Message::Text(text) => {
                state.metrics.ws_messages_in.fetch_add(1, Ordering::Relaxed);

                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(parsed) => session.handle(parsed).await,
                    Err(error) => {
                        tracing::debug!(?error, "unparseable client message");
                        session
                            .reply(&ServerMessage::Error {
                                code: ErrorCode::InvalidMessage,
                                message: "Unrecognised message.".into(),
                                retry_after_ms: None,
                            })
                            .await;
                    }
                }
            }
            Message::Ping(payload) => {
                // axum answers pings automatically; nothing to do.
                let _ = payload;
            }
            Message::Pong(_) => {}
            Message::Close(_) => break,
            Message::Binary(_) => {
                // The protocol is JSON text only. Binary means a confused or
                // hostile client.
                break;
            }
        }
    }

    // --- Teardown ----------------------------------------------------------
    writer.abort();

    let departed = room.detach(user.id).await;
    if departed {
        state
            .hub
            .broadcast(&room, &ServerMessage::ParticipantLeft { user_id: user.id })
            .await;
        state
            .hub
            .broadcast(
                &room,
                &ServerMessage::VoicePeerLeft { user_id: user.id },
            )
            .await;

        // A room without a host cannot be moderated, skipped or reconfigured by
        // anyone, so someone still present has to inherit it — but not
        // instantly. A refresh is indistinguishable from a departure at this
        // layer: both close the socket. Handing the room over immediately meant
        // every host who reloaded the page came back as an ordinary member,
        // with their own room in someone else's hands.
        if room.info.read().await.host_id == user.id {
            schedule_host_handover(state.clone(), Arc::clone(&room), user.id);
        }
    }

    let remaining = room.participant_count().await as i32;
    let _ = db::rooms::touch_activity(&state.db, room_id, remaining).await;
    // Starts the grace period. The sweep, not this line, is what closes the
    // room — a host who refreshes must find their room still standing.
    let _ = db::rooms::set_emptiness(&state.db, room_id, remaining == 0).await;
    let _ = db::users::touch_last_seen(&state.db, user.id).await;

    state.hub.release(room_id).await;
    Ok(())
}

/// Wait out the grace period, then hand the room over if the host is really gone.
///
/// Detached rather than awaited: the socket that triggered this is already
/// closing, and blocking its teardown for the length of the grace period would
/// hold the connection's task open for no reason.
///
/// Everything is re-checked after the sleep, because all of it can change while
/// we wait — the host may reconnect, someone else may be handed the room
/// explicitly, or the last person may leave and take the room with them.
fn schedule_host_handover(state: AppState, room: Arc<Room>, departing: Uuid) {
    let grace = state.config.realtime.host_grace;

    tokio::spawn(async move {
        tokio::time::sleep(grace).await;

        // Reconnected inside the grace period, on this node or another: their
        // presence is enough, whatever socket it arrived on.
        if room.state.lock().await.participants.contains_key(&departing) {
            tracing::debug!(room = %room.id, host = %departing, "host returned within grace");
            return;
        }

        // Somebody else already holds the room — an explicit transfer, or the
        // owner reclaiming it on their way back in.
        if room.info.read().await.host_id != departing {
            return;
        }

        // The room emptied out. The empty-room sweep owns it now, and promoting
        // a participant who is no longer here would only leave a stale host row.
        if room.participant_count().await == 0 {
            return;
        }

        promote_after_departure(&state, &room, departing).await;
    });
}

/// Hand the room to whoever is left after the host disconnects.
///
/// Failures are logged rather than propagated: this runs during teardown, and
/// a socket that is already closing has nowhere to report an error to. The
/// worst case is a room whose host row is stale until the next join, which the
/// reclaim path then corrects.
async fn promote_after_departure(state: &AppState, room: &Arc<Room>, departing: Uuid) {
    let nominated = room.info.read().await.successor_id;
    let candidates = room.succession_candidates().await;

    let Some(next) = crate::rooms::lifecycle::choose_successor(&candidates, departing, nominated)
    else {
        // Nobody left. The empty-room clock started by the caller takes over.
        return;
    };

    if let Err(error) =
        db::rooms::transfer_host(&state.db, room.id, departing, next, false).await
    {
        tracing::error!(?error, room = %room.id, "failed to promote a new host");
        return;
    }

    {
        let mut info = room.info.write().await;
        info.host_id = next;
        info.successor_id = None;
    }

    let promoted = room.set_role_local(next, Role::Host).await;
    let name = promoted
        .as_ref()
        .map(|p| p.user.display_name.clone())
        .unwrap_or_else(|| "Someone".to_string());

    db::history::audit(
        &state.db,
        Some(departing),
        Some(room.id),
        "room.host_auto_transferred",
        serde_json::json!({ "to": next, "nominated": nominated }),
    )
    .await;

    if let Some(participant) = promoted {
        state
            .hub
            .broadcast(room, &ServerMessage::ParticipantUpdated { participant })
            .await;
    }

    // Inheriting a room has to arrive as authority, not just as a label in the
    // participant list — otherwise the new host sees the badge but none of the
    // controls until they reload.
    let settings = room.info.read().await.settings.clone();
    state
        .hub
        .broadcast(
            room,
            &ServerMessage::PermissionsUpdated {
                user_id: next,
                role: Role::Host.as_str().to_string(),
                permissions: permissions::resolve(Role::Host, &settings),
            },
        )
        .await;

    announce_host_change(state, room, &format!("{name} is now hosting.")).await;
}

/// Broadcast a host change and record it in the room's own history.
///
/// The room snapshot carries `hostId`, so clients recompute their own
/// permissions from it; the chat line is what makes the change legible to
/// people who were not watching the participant list.
async fn announce_host_change(state: &AppState, room: &Arc<Room>, message: &str) {
    let snapshot = room.info.read().await.clone();

    state
        .hub
        .broadcast(room, &ServerMessage::RoomUpdated { room: snapshot })
        .await;

    for participant in room.snapshot_participants().await {
        state
            .hub
            .broadcast(room, &ServerMessage::ParticipantUpdated { participant })
            .await;
    }

    db::chat::insert_system(&state.db, room.id, "host_changed", message)
        .await
        .ok();
}

/// Read frames until the `authenticate` message arrives.
async fn await_authentication(
    stream: &mut futures_util::stream::SplitStream<WebSocket>,
) -> Result<String, &'static str> {
    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => {
                return match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(ClientMessage::Authenticate { ticket }) => Ok(ticket),
                    _ => Err("first frame was not an authentication"),
                };
            }
            Message::Close(_) => return Err("closed during handshake"),
            // Ignore transport-level frames while waiting.
            _ => continue,
        }
    }
    Err("stream ended during handshake")
}

/// Redeem a single-use ticket. `GETDEL` makes redemption atomic, so the same
/// ticket cannot open two sockets.
async fn redeem_ticket(
    state: &AppState,
    ticket: &str,
    room_id: Uuid,
) -> Option<crate::auth::tokens::WsTicket> {
    let mut redis = state.redis.clone();
    let key = cache::keys::ws_ticket(&util::sha256_hex(ticket));

    let payload: crate::auth::tokens::WsTicket =
        cache::take_json(&mut redis, &key).await.ok().flatten()?;

    // A ticket is bound to one room; presenting it elsewhere is rejected.
    (payload.room_id == room_id).then_some(payload)
}

async fn build_ready(
    state: &AppState,
    room: &Arc<Room>,
    session: &Session,
) -> Result<ServerMessage, AppError> {
    let info = room.info.read().await.clone();

    let timeline = {
        let mut guard = room.state.lock().await;
        guard
            .timeline
            .get_or_insert_with(|| crate::sync::Timeline::idle(util::now_ms()))
            .clone()
    };

    let queue_rows = db::queue::list_pending(&state.db, room.id).await?;
    let recent = db::chat::recent(&state.db, room.id, 60).await?;
    let pinned = db::chat::pinned(&state.db, room.id).await?;

    let mut author_ids: Vec<Uuid> = queue_rows.iter().filter_map(|i| i.added_by).collect();
    author_ids.extend(recent.iter().filter_map(|m| m.author_id));
    author_ids.extend(pinned.iter().filter_map(|m| m.author_id));
    author_ids.sort();
    author_ids.dedup();

    let users = db::users::find_many(&state.db, &author_ids).await?;
    let lookup: std::collections::HashMap<Uuid, db::users::UserSummary> = users
        .iter()
        .map(|u| (u.id, db::users::UserSummary::from(u)))
        .collect();

    let to_entry = |row: &db::chat::ChatMessage| ChatEntry {
        id: row.id,
        author: row
            .author_id
            .and_then(|id| lookup.get(&id).cloned())
            .unwrap_or_else(system_author),
        body: row.body.clone(),
        sent_at: row.sent_at.timestamp_millis(),
        edited_at: row.edited_at.map(|t| t.timestamp_millis()),
        reply_to: row.reply_to,
        pinned: row.pinned,
        nonce: None,
        mentions: row.mentions.clone(),
        system: row.system_kind.clone(),
    };

    Ok(ServerMessage::Ready(Box::new(ReadyPayload {
        self_user: session.user.clone(),
        role: session.role.as_str().to_string(),
        permissions: session.permissions,
        room: info,
        timeline,
        participants: room.snapshot_participants().await,
        queue: queue_rows
            .iter()
            .map(|item| {
                let author = item
                    .added_by
                    .and_then(|id| lookup.get(&id).cloned())
                    .unwrap_or_else(system_author);
                crate::realtime::protocol::QueueEntry::from_row(item, author)
            })
            .collect(),
        recent_messages: recent.iter().map(to_entry).collect(),
        pinned_messages: pinned.iter().map(to_entry).collect(),
        ice_servers: ice_servers(&state.config.voice),
        // Seeds the client's offset estimate before its first ping lands.
        server_time: util::now_ms(),
    })))
}

fn error_frame(code: ErrorCode, message: &str) -> String {
    serde_json::to_string(&ServerMessage::Error {
        code,
        message: message.to_string(),
        retry_after_ms: None,
    })
    .unwrap_or_else(|_| r#"{"t":"error","code":"internal","message":"error"}"#.to_string())
}

/// Tell the client why before hanging up. A bare close leaves the UI unable to
/// distinguish "your session expired" from "the network died", and the two need
/// very different handling on the client.
async fn close_with(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    code: ErrorCode,
    message: &str,
) {
    let _ = sink
        .send(Message::Text(error_frame(code, message).into()))
        .await;
    let _ = sink.close().await;
}
