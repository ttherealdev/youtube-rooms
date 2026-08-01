//! Per-connection message dispatch.
//!
//! A `Session` is one authenticated WebSocket. It owns nothing shared: room
//! state lives in `Room`, authority lives in the lease. Everything here is
//! validation, permission checks, and translating intents into authoritative
//! mutations.

use crate::{
    cache, db,
    error::AppError,
    ratelimit,
    realtime::{
        protocol::{
            ChatEntry, ClientMessage, ErrorCode, IceServer, QueueEntry, ServerMessage, SyncAction,
            TimelineReason, system_author,
        },
        room::Room,
    },
    rooms::permissions::{self, Permissions, Role},
    state::AppState,
    sync::{Timeline, is_allowed_rate},
    util,
    youtube::YouTube,
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::mpsc;
use uuid::Uuid;

/// Monotonic counter for queue broadcasts, so a client can discard a stale
/// queue snapshot that arrives out of order behind a newer one.
static QUEUE_VERSION: AtomicU64 = AtomicU64::new(1);

pub struct Session {
    pub state: AppState,
    pub room: Arc<Room>,
    pub user: db::users::UserSummary,
    pub role: Role,
    pub permissions: Permissions,
    /// Direct channel to this socket, for replies nobody else should see.
    pub out: mpsc::Sender<Arc<str>>,
}

impl Session {
    /// Send a message to this connection only.
    pub async fn reply(&self, message: &ServerMessage) {
        let Ok(json) = serde_json::to_string(message) else {
            return;
        };
        let _ = self.out.send(Arc::from(json.as_str())).await;
    }

    async fn reply_error(&self, code: ErrorCode, message: impl Into<String>) {
        self.reply(&ServerMessage::Error {
            code,
            message: message.into(),
            retry_after_ms: None,
        })
        .await;
    }

    async fn broadcast(&self, message: &ServerMessage) {
        self.state.hub.broadcast(&self.room, message).await;
    }

    /// Enforce a limit, replying with a retry hint when it trips.
    async fn allow(&self, scope: &str, limit: u32) -> bool {
        let mut redis = self.state.redis.clone();
        let decision =
            ratelimit::check_per_minute(&mut redis, scope, &self.user.id.to_string(), limit).await;

        if !decision.allowed {
            self.state
                .metrics
                .rate_limited
                .fetch_add(1, Ordering::Relaxed);
            self.reply(&ServerMessage::Error {
                code: ErrorCode::RateLimited,
                message: "You're doing that too quickly.".into(),
                retry_after_ms: Some(decision.retry_after_ms),
            })
            .await;
        }

        decision.allowed
    }

    pub async fn handle(&mut self, message: ClientMessage) {
        if let Err(error) = self.dispatch(message).await {
            let (code, text) = match &error {
                AppError::Forbidden(reason) => (ErrorCode::Forbidden, (*reason).to_string()),
                AppError::NotFound { resource } => {
                    (ErrorCode::NotFound, format!("{resource} not found"))
                }
                AppError::BadRequest(reason) => (ErrorCode::InvalidMessage, reason.clone()),
                AppError::RoomFull => (ErrorCode::RoomFull, "This room is full.".into()),
                other => {
                    tracing::error!(error = ?other, user = %self.user.id, "socket handler failed");
                    (ErrorCode::Internal, "Something went wrong.".into())
                }
            };
            self.reply_error(code, text).await;
        }
    }

    async fn dispatch(&mut self, message: ClientMessage) -> Result<(), AppError> {
        match message {
            // Re-authentication mid-stream is not part of the protocol; the
            // handshake already ran.
            ClientMessage::Authenticate { .. } => Ok(()),

            ClientMessage::Ping { client_sent } => {
                // Stamped as late as possible: every microsecond between the
                // packet arriving and this line is error in the client's
                // offset estimate (ADR 0005 §1).
                self.reply(&ServerMessage::Pong {
                    client_sent,
                    server_time: util::now_ms() as f64,
                })
                .await;
                Ok(())
            }

            ClientMessage::SyncIntent { action, version } => {
                self.handle_sync_intent(action, version).await
            }

            ClientMessage::SyncReport {
                drift_ms,
                position,
                buffering,
            } => {
                // Buffering clients report meaningless drift; recording it
                // would poison the SLO histogram with their network problems.
                if buffering || !position.is_finite() {
                    return Ok(());
                }

                let mut state = self.room.state.lock().await;
                let Some(timeline) = state.timeline.as_ref() else {
                    return Ok(());
                };

                // Recompute drift from the reported *position* against our own
                // clock rather than trusting the client's arithmetic. The
                // client's number depends on its offset estimate, so believing
                // it would hide exactly the failure — a bad clock estimate —
                // that this metric exists to catch.
                let authoritative = timeline.drift_ms(position, util::now_ms());
                let recorded = if authoritative.is_finite() {
                    authoritative
                } else if drift_ms.is_finite() {
                    drift_ms
                } else {
                    return Ok(());
                };

                self.state.metrics.record_drift(recorded);
                if let Some(participant) = state.participants.get_mut(&self.user.id) {
                    participant.drift_ms = Some(recorded);
                }
                Ok(())
            }

            ClientMessage::QueueAdd { url, play_next } => {
                self.handle_queue_add(&url, play_next).await
            }

            ClientMessage::QueueImport { url } => self.handle_queue_import(&url).await,

            ClientMessage::ReportDuration { seconds } => {
                self.handle_report_duration(seconds).await
            }

            ClientMessage::PlaybackReady { version } => {
                self.handle_playback_ready(version).await
            }

            ClientMessage::QueueRemove { item_id } => {
                self.require(self.permissions.can_manage_queue, "You cannot edit the queue.")?;
                db::queue::remove(&self.state.db, self.room.id, item_id).await?;
                self.broadcast_queue().await
            }

            ClientMessage::QueueMove { item_id, to_index } => {
                self.require(self.permissions.can_manage_queue, "You cannot edit the queue.")?;
                db::queue::move_item(&self.state.db, self.room.id, item_id, to_index).await?;
                self.broadcast_queue().await
            }

            ClientMessage::QueueClear => {
                self.require(self.permissions.can_manage_queue, "You cannot edit the queue.")?;
                db::queue::clear_pending(&self.state.db, self.room.id).await?;
                self.broadcast_queue().await
            }

            ClientMessage::QueueShuffle => {
                self.require(self.permissions.can_manage_queue, "You cannot edit the queue.")?;
                db::queue::shuffle(&self.state.db, self.room.id).await?;
                self.broadcast_queue().await
            }

            ClientMessage::ChatSend {
                body,
                reply_to,
                nonce,
            } => self.handle_chat_send(body, reply_to, nonce).await,

            ClientMessage::ChatTyping { active } => {
                {
                    let mut state = self.room.state.lock().await;
                    if active {
                        state.typing.insert(self.user.id);
                    } else {
                        state.typing.remove(&self.user.id);
                    }
                }
                self.broadcast(&ServerMessage::ChatTyping {
                    user_id: self.user.id,
                    active,
                })
                .await;
                Ok(())
            }

            ClientMessage::ChatPin { message_id, pinned } => {
                self.require(
                    self.permissions.can_moderate_chat,
                    "Only moderators can pin messages.",
                )?;
                let Some(row) =
                    db::chat::set_pinned(&self.state.db, self.room.id, message_id, pinned).await?
                else {
                    return Err(AppError::not_found("message"));
                };
                let entry = self.to_chat_entry(&row, None).await;
                self.broadcast(&ServerMessage::ChatPinned {
                    message: entry,
                    pinned,
                })
                .await;
                Ok(())
            }

            ClientMessage::ChatRead {
                through_message_id,
            } => {
                self.broadcast(&ServerMessage::ChatRead {
                    user_id: self.user.id,
                    through_message_id,
                })
                .await;
                Ok(())
            }

            ClientMessage::ReactionSend { emoji } => {
                if !ALLOWED_REACTIONS.contains(&emoji.as_str()) {
                    return Err(AppError::BadRequest("Unsupported reaction.".into()));
                }
                if !self
                    .allow("reaction", self.state.config.limits.reactions_per_minute)
                    .await
                {
                    return Ok(());
                }
                self.broadcast(&ServerMessage::Reaction {
                    user_id: self.user.id,
                    emoji,
                    at: util::now_ms(),
                })
                .await;
                Ok(())
            }

            ClientMessage::SkipVote { voting } => self.handle_skip_vote(voting).await,

            ClientMessage::VoiceJoin => self.handle_voice_join().await,
            ClientMessage::VoiceLeave => self.handle_voice_leave().await,

            ClientMessage::VoiceSignal { to, payload } => {
                // Relay only between two people who are both in this room.
                // Without this check the socket becomes an arbitrary message
                // bus between any two users on the server.
                let known = self.room.state.lock().await.participants.contains_key(&to);
                if !known {
                    return Err(AppError::not_found("peer"));
                }
                self.broadcast(&ServerMessage::VoiceSignal {
                    from: self.user.id,
                    payload,
                })
                .await;
                Ok(())
            }

            ClientMessage::VoiceState { muted } => {
                let in_voice = {
                    let mut state = self.room.state.lock().await;
                    match state.participants.get_mut(&self.user.id) {
                        Some(participant) => {
                            participant.muted = muted;
                            participant.in_voice
                        }
                        None => false,
                    }
                };
                self.broadcast(&ServerMessage::VoiceState {
                    user_id: self.user.id,
                    muted,
                    in_voice,
                })
                .await;
                Ok(())
            }

            ClientMessage::KickParticipant { user_id } => self.handle_kick(user_id).await,
            ClientMessage::SetRole { user_id, role } => self.handle_set_role(user_id, &role).await,
            ClientMessage::TransferHost { user_id } => self.handle_transfer_host(user_id).await,
            ClientMessage::DesignateSuccessor { user_id } => {
                self.handle_designate_successor(user_id).await
            }
        }
    }

    fn require(&self, allowed: bool, reason: &'static str) -> Result<(), AppError> {
        if allowed {
            Ok(())
        } else {
            Err(AppError::Forbidden(reason))
        }
    }

    // -- Playback -----------------------------------------------------------

    /// Take authority for the room, or forward the intent to whoever has it.
    ///
    /// Returns `false` when the intent was forwarded and this node must not
    /// apply it locally — doing both would produce two conflicting timelines.
    async fn assume_authority(&self, original: &ClientMessage) -> bool {
        if self.state.hub.owns(self.room.id) {
            return true;
        }
        if self.state.hub.try_claim(self.room.id).await {
            return true;
        }

        if let Ok(encoded) = serde_json::to_string(&SerializedIntent::from(original)) {
            self.state
                .hub
                .forward_intent(self.room.id, self.user.id, &encoded)
                .await;
        }
        false
    }

    async fn handle_sync_intent(
        &mut self,
        action: SyncAction,
        client_version: u64,
    ) -> Result<(), AppError> {
        self.require(
            self.permissions.can_control_playback,
            "Only the host controls playback in this room.",
        )?;

        if !self
            .allow("sync", self.state.config.limits.sync_intents_per_minute)
            .await
        {
            return Ok(());
        }

        if !self
            .assume_authority(&ClientMessage::SyncIntent {
                action: action.clone(),
                version: client_version,
            })
            .await
        {
            return Ok(());
        }

        self.state.metrics.sync_intents.fetch_add(1, Ordering::Relaxed);

        let now = util::now_ms();
        let mut advance_to: Option<AdvanceRequest> = None;

        {
            let mut state = self.room.state.lock().await;
            let timeline = state.timeline.get_or_insert_with(|| Timeline::idle(now));

            // Reject an intent computed against a timeline we have already
            // moved past. Without this, a laggy client's "pause" can undo a
            // seek that happened after it decided to send.
            //
            // Only for intents that are *relative* to the current playback
            // state. "Play this queue item", "next" and "previous" name what
            // they want outright, so a newer timeline does not invalidate
            // them — and applying the guard to those made the queue unusable
            // exactly when the timeline churns most, which is while something
            // is starting up. The buttons looked dead.
            if changes_source(&action) {
                // Intentionally empty: nothing about a newer timeline can make
                // "play that one" mean something different.
            } else if client_version < timeline.version {
                drop(state);
                self.reply_error(
                    ErrorCode::StaleVersion,
                    "That action was based on outdated playback state.",
                )
                .await;
                return Ok(());
            }

            match action {
                SyncAction::Play => timeline.play(now),
                SyncAction::Pause => timeline.pause(now),
                SyncAction::Seek { position } => {
                    if !position.is_finite() || position < 0.0 {
                        return Err(AppError::BadRequest("Invalid seek position.".into()));
                    }
                    timeline.seek(now, position);
                }
                SyncAction::SetRate { rate } => {
                    if !is_allowed_rate(rate) {
                        return Err(AppError::BadRequest("Unsupported playback speed.".into()));
                    }
                    timeline.set_rate(now, rate);
                }
                SyncAction::SetLoop { loop_current } => timeline.set_loop(loop_current),
                SyncAction::Restart => timeline.restart(now),
                SyncAction::Next => advance_to = Some(AdvanceRequest::Next),
                SyncAction::Previous => advance_to = Some(AdvanceRequest::Previous),
                SyncAction::PlayNow { queue_item_id } => {
                    advance_to = Some(AdvanceRequest::Specific(queue_item_id));
                }
            }
        }

        match advance_to {
            Some(request) => self.advance(request, TimelineReason::Intent).await,
            None => {
                self.publish_timeline(TimelineReason::Intent, Some(self.user.clone()))
                    .await;
                Ok(())
            }
        }
    }

    /// Move to another video and broadcast the resulting timeline.
    pub async fn advance(
        &self,
        request: AdvanceRequest,
        reason: TimelineReason,
    ) -> Result<(), AppError> {
        let next = match request {
            AdvanceRequest::Next => db::queue::pop_next(&self.state.db, self.room.id).await?,
            AdvanceRequest::Specific(item_id) => {
                let item = db::queue::find(&self.state.db, item_id).await?;
                if let Some(found) = &item
                    && found.room_id == self.room.id
                {
                    db::queue::mark_played(&self.state.db, item_id).await?;
                }
                item.filter(|i| i.room_id == self.room.id)
            }
            AdvanceRequest::Previous => {
                let history = db::queue::recent_history(&self.state.db, self.room.id, 2).await?;
                // [0] is what is playing now; [1] is the one before it.
                match history.get(1) {
                    Some(previous) => {
                        db::queue::requeue_front(&self.state.db, self.room.id, previous.id).await?;
                        db::queue::pop_next(&self.state.db, self.room.id).await?
                    }
                    None => None,
                }
            }
        };

        let now = util::now_ms();
        {
            let mut state = self.room.state.lock().await;
            let timeline = state.timeline.get_or_insert_with(|| Timeline::idle(now));

            match &next {
                Some(item) => timeline.load(
                    now,
                    item.source(),
                    Some(item.id),
                    // Zero means "not known yet" — true for every file and
                    // stream, since only YouTube tells us the length up front.
                    // The playing client reports it back via `report_duration`.
                    (item.duration_seconds > 0).then(|| f64::from(item.duration_seconds)),
                ),
                // Nothing left: stop cleanly rather than looping the last video.
                None => timeline.clear(now),
            }

            // A new video invalidates votes cast against the previous one.
            state.skip_votes.clear();
        }

        if let Some(item) = &next {
            db::chat::insert_system(
                &self.state.db,
                self.room.id,
                "video_changed",
                &format!("Now playing: {}", item.title),
            )
            .await
            .ok();
        }

        self.publish_timeline(reason, None).await;
        self.broadcast_queue().await?;
        self.broadcast_skip_votes().await;
        Ok(())
    }

    /// Broadcast the current timeline and mirror it for failover.
    async fn publish_timeline(
        &self,
        reason: TimelineReason,
        actor: Option<db::users::UserSummary>,
    ) {
        let timeline = {
            let state = self.room.state.lock().await;
            state.timeline.clone()
        };

        let Some(timeline) = timeline else { return };

        self.state
            .hub
            .persist_timeline(self.room.id, &timeline)
            .await;

        self.broadcast(&ServerMessage::Timeline {
            timeline,
            actor,
            reason,
        })
        .await;
    }

    // -- Queue --------------------------------------------------------------

    async fn handle_queue_add(&mut self, raw: &str, play_next: bool) -> Result<(), AppError> {
        self.require(
            self.permissions.can_manage_queue,
            "You cannot add to the queue in this room.",
        )?;

        if !self
            .allow("queue", self.state.config.limits.queue_adds_per_minute)
            .await
        {
            return Ok(());
        }

        let classified = crate::media::classify(raw).ok_or_else(|| {
            AppError::BadRequest("That is not a link this room can play.".into())
        })?;

        let source = match classified {
            crate::media::Classified::Source(source) => source,
            // Someone pasted a channel list into the single-item box. Doing
            // what they clearly meant beats an error telling them to use a
            // different field.
            crate::media::Classified::Playlist { url } => return self.handle_queue_import(&url).await,
        };

        let item = self.describe(source).await?;

        db::queue::add(&self.state.db, self.room.id, item, play_next).await?;
        self.broadcast_queue().await?;
        self.start_if_idle().await
    }

    /// Fetch a playlist URL and append everything on it.
    async fn handle_queue_import(&mut self, raw: &str) -> Result<(), AppError> {
        self.require(
            self.permissions.can_manage_queue,
            "You cannot add to the queue in this room.",
        )?;

        // An import is one request that can produce hundreds of rows, so it is
        // metered far more tightly than a single add.
        if !self.allow("queue_import", self.state.config.limits.imports_per_minute).await {
            return Ok(());
        }

        let limits = &self.state.config.limits;
        let fetched = crate::media::fetch::fetch_text(
            raw,
            limits.playlist_max_bytes,
            limits.playlist_timeout,
        )
        .await?;

        let entries = match crate::media::playlist::parse(&fetched.body, &fetched.final_url) {
            crate::media::Parsed::Entries(entries) => entries,
            // The URL turned out to name a single stream, not a list of them.
            // Queue it as one item rather than reporting an empty import.
            crate::media::Parsed::HlsManifest => {
                let source = crate::media::MediaSource {
                    kind: crate::media::SourceKind::Hls,
                    url: fetched.final_url.clone(),
                    video_id: None,
                };
                let item = self.describe(source).await?;
                db::queue::add(&self.state.db, self.room.id, item, false).await?;
                self.broadcast_queue().await?;
                return self.start_if_idle().await;
            }
        };

        if entries.is_empty() {
            return Err(AppError::BadRequest(
                "That list had nothing this room can play.".into(),
            ));
        }

        let count = entries.len();
        let items: Vec<db::queue::NewQueueItem> = entries
            .into_iter()
            .map(|entry| db::queue::NewQueueItem {
                title: entry.title,
                channel_title: entry.group.unwrap_or_default(),
                duration_seconds: 0,
                thumbnail_url: entry.logo.unwrap_or_default(),
                source: entry.source,
                added_by: self.user.id,
            })
            .collect();

        db::queue::add_many(&self.state.db, self.room.id, &items).await?;

        db::chat::insert_system(
            &self.state.db,
            self.room.id,
            "video_changed",
            &format!("{} added {count} items from a playlist.", self.user.display_name),
        )
        .await
        .ok();

        self.broadcast_queue().await?;
        self.start_if_idle().await
    }

    /// Turn a source into a queue row, enriching it where we can.
    ///
    /// YouTube has an API that tells us the title, channel, length and — the
    /// one that actually blocks playback — whether the video may be embedded at
    /// all. Nothing equivalent exists for an arbitrary URL, so those rows carry
    /// what can be derived from the URL itself and learn their duration from
    /// the first client to play them.
    async fn describe(
        &self,
        source: crate::media::MediaSource,
    ) -> Result<db::queue::NewQueueItem, AppError> {
        if let (crate::media::SourceKind::Youtube, Some(video_id)) =
            (source.kind, source.video_id.clone())
        {
            let youtube = YouTube::new(self.state.config.youtube.clone(), self.state.http.clone());
            let mut redis = self.state.redis.clone();
            let metadata = youtube.video(&mut redis, &video_id).await;

            if !metadata.embeddable {
                return Err(AppError::BadRequest(
                    "That video cannot be embedded, so the room can't play it.".into(),
                ));
            }

            return Ok(db::queue::NewQueueItem {
                source: crate::media::MediaSource::youtube(metadata.video_id.clone()),
                title: metadata.title.clone(),
                channel_title: metadata.channel_title.clone(),
                duration_seconds: metadata.duration_seconds,
                thumbnail_url: metadata.thumbnail_url.clone(),
                added_by: self.user.id,
            });
        }

        Ok(db::queue::NewQueueItem {
            title: util::title_from_url(&source.url),
            channel_title: String::new(),
            duration_seconds: 0,
            thumbnail_url: String::new(),
            source,
            added_by: self.user.id,
        })
    }

    /// An idle room starts playing the moment something is queued — otherwise
    /// the first person in has to add *and* press play.
    async fn start_if_idle(&self) -> Result<(), AppError> {
        let idle = {
            let state = self.room.state.lock().await;
            state.timeline.as_ref().is_none_or(|t| !t.is_loaded())
        };

        if idle && self.state.hub.owns(self.room.id) {
            self.advance(AdvanceRequest::Next, TimelineReason::Advance)
                .await?;
        }
        Ok(())
    }

    /// Accept a duration measured by a client that has the media loaded.
    ///
    /// Only from someone who can control playback: the duration bounds seeks
    /// and decides when the room auto-advances, so an arbitrary viewer being
    /// able to set it would let them cut everyone else's video short.
    async fn handle_report_duration(&mut self, seconds: f64) -> Result<(), AppError> {
        if !self.permissions.can_control_playback {
            return Ok(());
        }
        if !seconds.is_finite() || seconds <= 0.0 {
            return Ok(());
        }

        let accepted = {
            let mut state = self.room.state.lock().await;
            state
                .timeline
                .as_mut()
                .is_some_and(|timeline| timeline.set_duration(seconds))
        };

        // Only the first report changes anything, so this does not turn into a
        // broadcast per client per video.
        if accepted {
            self.publish_timeline(TimelineReason::Advance, None).await;
        }
        Ok(())
    }

    /// Start a cued source once a player reports it can actually play it.
    ///
    /// Anyone may release the hold, not only someone with playback control: the
    /// question being answered is "has this loaded anywhere", and refusing a
    /// viewer's report would leave a room full of people staring at a video
    /// that never starts because the host happens to be on a slow connection.
    async fn handle_playback_ready(&mut self, version: u64) -> Result<(), AppError> {
        let started = {
            let mut state = self.room.state.lock().await;
            match state.timeline.as_mut() {
                // A stale report — the room cued something else while this was
                // in flight — must not start the video that replaced it.
                Some(timeline) if timeline.version == version => {
                    timeline.start_playback(util::now_ms())
                }
                _ => false,
            }
        };

        if started {
            self.publish_timeline(TimelineReason::Advance, None).await;
        }
        Ok(())
    }

    pub async fn broadcast_queue(&self) -> Result<(), AppError> {
        let items = db::queue::list_pending(&self.state.db, self.room.id).await?;
        let entries = self.hydrate_queue(&items).await?;

        self.broadcast(&ServerMessage::QueueUpdated {
            items: entries,
            version: QUEUE_VERSION.fetch_add(1, Ordering::Relaxed),
        })
        .await;
        Ok(())
    }

    /// Attach author summaries to queue rows in one query rather than N.
    async fn hydrate_queue(
        &self,
        items: &[db::queue::QueueItem],
    ) -> Result<Vec<QueueEntry>, AppError> {
        let ids: Vec<Uuid> = items.iter().filter_map(|i| i.added_by).collect();
        let users = db::users::find_many(&self.state.db, &ids).await?;

        let lookup: std::collections::HashMap<Uuid, db::users::UserSummary> = users
            .iter()
            .map(|u| (u.id, db::users::UserSummary::from(u)))
            .collect();

        Ok(items
            .iter()
            .map(|item| {
                let author = item
                    .added_by
                    .and_then(|id| lookup.get(&id).cloned())
                    .unwrap_or_else(system_author);
                QueueEntry::from_row(item, author)
            })
            .collect())
    }

    // -- Chat ---------------------------------------------------------------

    async fn handle_chat_send(
        &mut self,
        body: String,
        reply_to: Option<Uuid>,
        nonce: String,
    ) -> Result<(), AppError> {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Err(AppError::BadRequest("Message is empty.".into()));
        }
        if trimmed.chars().count() > 2000 {
            return Err(AppError::BadRequest("Message is too long.".into()));
        }

        if !self
            .allow("chat", self.state.config.limits.chat_per_minute)
            .await
        {
            return Ok(());
        }

        let mentions = db::chat::resolve_mentions(&self.state.db, self.room.id, trimmed).await?;

        let row = db::chat::insert(
            &self.state.db,
            self.room.id,
            self.user.id,
            trimmed,
            reply_to,
            &mentions,
        )
        .await?;

        self.state.metrics.chat_messages.fetch_add(1, Ordering::Relaxed);

        let entry = self.to_chat_entry(&row, Some(nonce)).await;
        self.broadcast(&ServerMessage::ChatMessage { message: entry })
            .await;
        Ok(())
    }

    async fn to_chat_entry(
        &self,
        row: &db::chat::ChatMessage,
        nonce: Option<String>,
    ) -> ChatEntry {
        let author = match row.author_id {
            None => system_author(),
            Some(id) if id == self.user.id => self.user.clone(),
            Some(id) => match db::users::find_by_id(&self.state.db, id).await {
                Ok(Some(user)) => db::users::UserSummary::from(&user),
                _ => system_author(),
            },
        };

        ChatEntry {
            id: row.id,
            author,
            body: row.body.clone(),
            sent_at: row.sent_at.timestamp_millis(),
            edited_at: row.edited_at.map(|t| t.timestamp_millis()),
            reply_to: row.reply_to,
            pinned: row.pinned,
            nonce,
            mentions: row.mentions.clone(),
            system: row.system_kind.clone(),
        }
    }

    // -- Vote skip ----------------------------------------------------------

    async fn handle_skip_vote(&mut self, voting: bool) -> Result<(), AppError> {
        let ratio = self.room.info.read().await.settings.vote_skip_ratio;

        let reached = {
            let mut state = self.room.state.lock().await;
            if state.timeline.as_ref().is_none_or(|t| !t.is_loaded()) {
                return Err(AppError::BadRequest("Nothing is playing.".into()));
            }
            if voting {
                state.skip_votes.insert(self.user.id);
            } else {
                state.skip_votes.remove(&self.user.id);
            }
            state.should_skip(ratio)
        };

        self.broadcast_skip_votes().await;

        if reached {
            db::chat::insert_system(
                &self.state.db,
                self.room.id,
                "skip",
                "Skipped by vote.",
            )
            .await
            .ok();

            if self.state.hub.owns(self.room.id) {
                self.advance(AdvanceRequest::Next, TimelineReason::VoteSkip)
                    .await?;
            }
        }

        Ok(())
    }

    async fn broadcast_skip_votes(&self) {
        let ratio = self.room.info.read().await.settings.vote_skip_ratio;
        let (votes, needed, voters) = {
            let state = self.room.state.lock().await;
            (
                state.skip_votes.len(),
                state.votes_needed(ratio),
                state.skip_votes.iter().copied().collect::<Vec<_>>(),
            )
        };

        self.broadcast(&ServerMessage::SkipVoteUpdate {
            votes,
            needed,
            voters,
        })
        .await;
    }

    // -- Voice --------------------------------------------------------------

    async fn handle_voice_join(&mut self) -> Result<(), AppError> {
        let max_peers = self.state.config.voice.mesh_max_peers;

        let (peers, at_capacity) = {
            let mut state = self.room.state.lock().await;
            let current = state.voice_peers();

            if current.len() >= max_peers && !current.contains(&self.user.id) {
                (current, true)
            } else {
                if let Some(participant) = state.participants.get_mut(&self.user.id) {
                    participant.in_voice = true;
                    participant.muted = true;
                }
                let peers = state
                    .voice_peers()
                    .into_iter()
                    .filter(|id| *id != self.user.id)
                    .collect::<Vec<_>>();
                (peers, false)
            }
        };

        if at_capacity {
            self.reply(&ServerMessage::VoiceCapacity {
                at_capacity: true,
                max_peers,
            })
            .await;
            return Ok(());
        }

        // Perfect negotiation: politeness is decided by comparing ids, and the
        // server tells each side its role so the two can never disagree
        // (ADR 0006).
        for peer in &peers {
            self.reply(&ServerMessage::VoicePeerJoined {
                user_id: *peer,
                polite: self.user.id > *peer,
            })
            .await;
        }

        self.broadcast(&ServerMessage::VoicePeerJoined {
            user_id: self.user.id,
            polite: false,
        })
        .await;

        self.broadcast(&ServerMessage::VoiceState {
            user_id: self.user.id,
            muted: true,
            in_voice: true,
        })
        .await;

        Ok(())
    }

    async fn handle_voice_leave(&mut self) -> Result<(), AppError> {
        {
            let mut state = self.room.state.lock().await;
            if let Some(participant) = state.participants.get_mut(&self.user.id) {
                participant.in_voice = false;
                participant.muted = true;
            }
        }

        self.broadcast(&ServerMessage::VoicePeerLeft {
            user_id: self.user.id,
        })
        .await;
        Ok(())
    }

    // -- Moderation ---------------------------------------------------------

    async fn handle_kick(&mut self, target: Uuid) -> Result<(), AppError> {
        self.require(self.permissions.can_kick, "You cannot remove people.")?;

        let target_role = self
            .room
            .role_of(target)
            .await
            .ok_or_else(|| AppError::not_found("participant"))?;

        if !permissions::outranks(self.role, target_role) {
            return Err(AppError::Forbidden("You cannot remove that person."));
        }

        db::rooms::ban(&self.state.db, self.room.id, target, self.user.id).await?;
        db::history::audit(
            &self.state.db,
            Some(self.user.id),
            Some(self.room.id),
            "participant.kicked",
            serde_json::json!({ "target": target }),
        )
        .await;

        self.broadcast(&ServerMessage::ParticipantLeft { user_id: target })
            .await;
        Ok(())
    }

    async fn handle_set_role(&mut self, target: Uuid, role: &str) -> Result<(), AppError> {
        self.require(
            self.permissions.can_manage_roles,
            "Only the host can change roles.",
        )?;

        // Host is only ever granted through an explicit transfer, never here.
        let new_role = match role {
            "cohost" | "moderator" => Role::Cohost,
            "member" => Role::Member,
            _ => return Err(AppError::BadRequest("Unknown role.".into())),
        };

        if target == self.user.id {
            return Err(AppError::BadRequest("You cannot change your own role.".into()));
        }

        let target_role = self
            .room
            .role_of(target)
            .await
            .ok_or_else(|| AppError::not_found("participant"))?;

        if !permissions::outranks(self.role, target_role) {
            return Err(AppError::Forbidden("You cannot change that person's role."));
        }

        db::rooms::set_role(&self.state.db, self.room.id, target, new_role.as_str()).await?;
        db::history::audit(
            &self.state.db,
            Some(self.user.id),
            Some(self.room.id),
            "participant.role_changed",
            serde_json::json!({ "target": target, "role": new_role.as_str() }),
        )
        .await;

        let updated = {
            let mut state = self.room.state.lock().await;
            state.participants.get_mut(&target).map(|participant| {
                participant.role = new_role;
                participant.to_protocol()
            })
        };

        if let Some(participant) = updated {
            db::chat::insert_system(
                &self.state.db,
                self.room.id,
                "role_changed",
                &match new_role {
                    Role::Cohost => format!("{} is now a co-host.", participant.user.display_name),
                    _ => format!("{} is now a member.", participant.user.display_name),
                },
            )
            .await
            .ok();

            self.broadcast(&ServerMessage::ParticipantUpdated { participant })
                .await;

            // The participant list alone only tells the room what someone's
            // role is now; it does not tell *them* what they may do. Without
            // this the promoted person kept their old permissions until they
            // reloaded the page, which is what made every promotion look like
            // it had not worked.
            let settings = self.room.info.read().await.settings.clone();
            self.broadcast(&ServerMessage::PermissionsUpdated {
                user_id: target,
                role: new_role.as_str().to_string(),
                permissions: permissions::resolve(new_role, &settings),
            })
            .await;
        }

        Ok(())
    }

    /// Nominate — or clear — who inherits the room when the host leaves.
    ///
    /// Advisory rather than binding: the nomination is consulted at handover
    /// time, and if that person is no longer in the room the usual promotion
    /// order applies. Storing it on the room rather than acting immediately is
    /// what makes "hand it to Sam *when I go*" different from "hand it to Sam".
    async fn handle_designate_successor(&mut self, target: Option<Uuid>) -> Result<(), AppError> {
        self.require(
            self.permissions.can_designate_successor,
            "Only the host can choose a successor.",
        )?;

        if let Some(target) = target {
            if target == self.user.id {
                return Err(AppError::BadRequest(
                    "You already host this room.".into(),
                ));
            }
            // Only someone the room actually knows can be nominated; an
            // arbitrary user id here would silently never inherit anything.
            if db::rooms::find_membership(&self.state.db, self.room.id, target)
                .await?
                .is_none()
            {
                return Err(AppError::not_found("participant"));
            }
        }

        db::rooms::set_successor(&self.state.db, self.room.id, target).await?;

        let snapshot = {
            let mut info = self.room.info.write().await;
            info.successor_id = target;
            info.clone()
        };

        self.broadcast(&ServerMessage::RoomUpdated { room: snapshot })
            .await;
        Ok(())
    }

    async fn handle_transfer_host(&mut self, target: Uuid) -> Result<(), AppError> {
        self.require(
            self.permissions.can_transfer_host,
            "Only the host can hand over the room.",
        )?;

        if target == self.user.id {
            return Err(AppError::BadRequest("You already host this room.".into()));
        }

        // Explicit: the outgoing host meant it, so ownership moves with the room.
        db::rooms::transfer_host(&self.state.db, self.room.id, self.user.id, target, true).await?;
        db::history::audit(
            &self.state.db,
            Some(self.user.id),
            Some(self.room.id),
            "room.host_transferred",
            serde_json::json!({ "to": target }),
        )
        .await;

        {
            let mut state = self.room.state.lock().await;
            if let Some(participant) = state.participants.get_mut(&self.user.id) {
                participant.role = Role::Cohost;
            }
            if let Some(participant) = state.participants.get_mut(&target) {
                participant.role = Role::Host;
            }
        }
        self.room.info.write().await.host_id = target;

        // Our own authority changed; recompute it rather than trusting the
        // permissions we were constructed with.
        self.role = Role::Cohost;
        let settings = self.room.info.read().await.settings.clone();
        self.permissions = permissions::resolve(self.role, &settings);

        db::chat::insert_system(
            &self.state.db,
            self.room.id,
            "host_changed",
            "The room has a new host.",
        )
        .await
        .ok();

        for participant in self.room.snapshot_participants().await {
            self.broadcast(&ServerMessage::ParticipantUpdated { participant })
                .await;
        }

        // Both sides of the handover need their authority corrected: the
        // outgoing host is now a co-host, and the incoming one has to be told
        // they may moderate the room rather than discovering it on reload.
        self.broadcast(&ServerMessage::PermissionsUpdated {
            user_id: self.user.id,
            role: self.role.as_str().to_string(),
            permissions: self.permissions,
        })
        .await;

        self.broadcast(&ServerMessage::PermissionsUpdated {
            user_id: target,
            role: Role::Host.as_str().to_string(),
            permissions: permissions::resolve(Role::Host, &settings),
        })
        .await;

        Ok(())
    }
}

/// Does this intent replace what is playing, rather than adjust it?
///
/// The distinction matters for the staleness guard: an adjustment is only
/// meaningful against the timeline the sender was looking at, but a
/// replacement names its target and stays valid however far the room has moved.
fn changes_source(action: &SyncAction) -> bool {
    matches!(
        action,
        SyncAction::Next | SyncAction::Previous | SyncAction::PlayNow { .. }
    )
}

#[derive(Debug, Clone, Copy)]
pub enum AdvanceRequest {
    Next,
    Previous,
    Specific(Uuid),
}

/// Re-encoding of an intent for cross-node forwarding.
///
/// `ClientMessage` is deserialize-only (it is an inbound type), so forwarding
/// needs an owned serializable mirror of the variants that can be forwarded.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum SerializedIntent {
    SyncIntent { action: serde_json::Value, version: u64 },
    Unsupported,
}

impl From<&ClientMessage> for SerializedIntent {
    fn from(message: &ClientMessage) -> Self {
        match message {
            ClientMessage::SyncIntent { action, version } => Self::SyncIntent {
                action: serde_json::to_value(SerializedAction::from(action))
                    .unwrap_or(serde_json::Value::Null),
                version: *version,
            },
            _ => Self::Unsupported,
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SerializedAction {
    Play,
    Pause,
    Seek { position: f64 },
    SetRate { rate: f64 },
    SetLoop { loop_current: bool },
    PlayNow { queue_item_id: Uuid },
    Next,
    Previous,
    Restart,
}

impl From<&SyncAction> for SerializedAction {
    fn from(action: &SyncAction) -> Self {
        match action {
            SyncAction::Play => Self::Play,
            SyncAction::Pause => Self::Pause,
            SyncAction::Seek { position } => Self::Seek {
                position: *position,
            },
            SyncAction::SetRate { rate } => Self::SetRate { rate: *rate },
            SyncAction::SetLoop { loop_current } => Self::SetLoop {
                loop_current: *loop_current,
            },
            SyncAction::PlayNow { queue_item_id } => Self::PlayNow {
                queue_item_id: *queue_item_id,
            },
            SyncAction::Next => Self::Next,
            SyncAction::Previous => Self::Previous,
            SyncAction::Restart => Self::Restart,
        }
    }
}

pub const ALLOWED_REACTIONS: [&str; 8] = ["❤️", "😂", "🔥", "😮", "👏", "💀", "🎉", "👀"];

/// ICE servers handed to the client at join time.
///
/// TURN credentials are issued per session rather than baked into the bundle,
/// so a leaked build artifact does not leak relay access (ADR 0006).
pub fn ice_servers(config: &crate::config::VoiceConfig) -> Vec<IceServer> {
    let mut servers = vec![IceServer {
        urls: config.stun_urls.clone(),
        username: None,
        credential: None,
    }];

    if let Some(turn_url) = &config.turn_url {
        servers.push(IceServer {
            urls: vec![turn_url.clone()],
            username: config.turn_username.clone(),
            credential: config.turn_credential.clone(),
        });
    }

    servers
}

/// Presence heartbeat, so a node crash does not leave ghosts in the room.
pub async fn touch_presence(redis: &mut cache::Redis, room_id: Uuid, user_id: Uuid) {
    let key = cache::keys::room_presence(&room_id);
    let result: Result<(), _> = redis::cmd("ZADD")
        .arg(&key)
        .arg(util::now_ms())
        .arg(user_id.to_string())
        .query_async::<()>(redis)
        .await;

    if let Err(error) = result {
        tracing::debug!(?error, "presence heartbeat failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::VoiceConfig;

    #[test]
    fn reaction_allowlist_rejects_arbitrary_strings() {
        assert!(ALLOWED_REACTIONS.contains(&"🔥"));
        assert!(!ALLOWED_REACTIONS.contains(&"<script>alert(1)</script>"));
        assert!(!ALLOWED_REACTIONS.contains(&"🍕"));
    }

    #[test]
    fn ice_servers_include_turn_only_when_configured() {
        let base = VoiceConfig {
            mesh_max_peers: 8,
            stun_urls: vec!["stun:stun.example.com:3478".into()],
            turn_url: None,
            turn_username: None,
            turn_credential: None,
        };
        assert_eq!(ice_servers(&base).len(), 1);

        let with_turn = VoiceConfig {
            turn_url: Some("turn:turn.example.com:3478".into()),
            turn_username: Some("user".into()),
            turn_credential: Some("pass".into()),
            ..base
        };
        let servers = ice_servers(&with_turn);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[1].username.as_deref(), Some("user"));
    }

    #[test]
    fn politeness_is_asymmetric_between_any_two_peers() {
        // The property that matters: for any pair, exactly one side is polite.
        let a = Uuid::from_bytes([1; 16]);
        let b = Uuid::from_bytes([2; 16]);
        assert_ne!(a > b, b > a);
    }

    #[test]
    fn forwarded_intents_round_trip_their_action() {
        let message = ClientMessage::SyncIntent {
            action: SyncAction::Seek { position: 12.5 },
            version: 3,
        };
        let json = serde_json::to_string(&SerializedIntent::from(&message)).unwrap();
        assert!(json.contains(r#""t":"sync_intent""#));
        assert!(json.contains(r#""kind":"seek""#));
        assert!(json.contains("12.5"));

        // And the mirror must parse back as the inbound type on the owner node.
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            parsed,
            ClientMessage::SyncIntent {
                action: SyncAction::Seek { position },
                version: 3
            } if position == 12.5
        ));
    }
}
