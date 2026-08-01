//! The WebSocket wire protocol.
//!
//! This enum is canonical; `packages/protocol` mirrors it in Zod (ADR 0011).
//! Both directions are `#[serde(tag = "t")]` discriminated unions, which is
//! what makes an unhandled message variant a **compile error** rather than a
//! silently ignored packet — the single most valuable property of doing this in
//! Rust (ADR 0002).

use crate::{
    db::{queue::QueueItem, rooms::RoomSettings, users::UserSummary},
    sync::Timeline,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Must be the first frame. The socket is closed if it does not arrive
    /// within `WS_HANDSHAKE_TIMEOUT_SECS`.
    Authenticate { ticket: String },

    /// Clock probe. See ADR 0005 §1.
    Ping {
        #[serde(rename = "clientSent")]
        client_sent: f64,
    },

    SyncIntent {
        action: SyncAction,
        /// Timeline version the client believed it was acting on.
        version: u64,
    },

    /// Periodic drift measurement, feeding the SLO histogram.
    SyncReport {
        #[serde(rename = "driftMs")]
        drift_ms: f64,
        position: f64,
        buffering: bool,
    },

    /// Add one source. `url` is anything a user can paste — a YouTube link or
    /// id, a direct media URL, or a stream manifest — and the server decides
    /// how it will be played.
    QueueAdd {
        url: String,
        #[serde(default, rename = "playNext")]
        play_next: bool,
    },

    /// Expand a playlist URL and append everything on it.
    QueueImport {
        url: String,
    },

    /// Duration discovered by whichever client is playing.
    ///
    /// Files and streams do not advertise a length until a player has loaded
    /// them, so the room cannot clamp seeks or auto-advance without this.
    ReportDuration {
        seconds: f64,
    },

    /// "My player has this source buffered and can start."
    ///
    /// Releases the hold `Timeline::load` puts on a freshly cued source. The
    /// version identifies which cue is being answered, so a report that was in
    /// flight while the room moved on cannot start the wrong video.
    PlaybackReady {
        version: u64,
    },
    QueueRemove {
        #[serde(rename = "itemId")]
        item_id: Uuid,
    },
    QueueMove {
        #[serde(rename = "itemId")]
        item_id: Uuid,
        #[serde(rename = "toIndex")]
        to_index: usize,
    },
    QueueClear,
    QueueShuffle,

    ChatSend {
        body: String,
        #[serde(default, rename = "replyTo")]
        reply_to: Option<Uuid>,
        /// Echoed back so an optimistic bubble is replaced, not duplicated.
        nonce: String,
    },
    ChatTyping {
        active: bool,
    },
    ChatPin {
        #[serde(rename = "messageId")]
        message_id: Uuid,
        pinned: bool,
    },
    ChatRead {
        #[serde(rename = "throughMessageId")]
        through_message_id: Uuid,
    },

    ReactionSend {
        emoji: String,
    },

    SkipVote {
        voting: bool,
    },

    VoiceJoin,
    VoiceLeave,
    VoiceSignal {
        to: Uuid,
        payload: serde_json::Value,
    },
    VoiceState {
        muted: bool,
    },

    KickParticipant {
        #[serde(rename = "userId")]
        user_id: Uuid,
    },
    SetRole {
        #[serde(rename = "userId")]
        user_id: Uuid,
        role: String,
    },
    TransferHost {
        #[serde(rename = "userId")]
        user_id: Uuid,
    },
    /// Nominate who inherits the room when the host leaves. `None` clears the
    /// nomination and restores the default promotion order.
    DesignateSuccessor {
        #[serde(default, rename = "userId")]
        user_id: Option<Uuid>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncAction {
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

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Complete room state. Sent once after authentication and again after
    /// every reconnect — snapshots are small and idempotent, which removes an
    /// entire class of missed-delta bugs (ADR 0004).
    Ready(Box<ReadyPayload>),

    Pong {
        #[serde(rename = "clientSent")]
        client_sent: f64,
        /// Stamped as late as possible in the handler.
        #[serde(rename = "serverTime")]
        server_time: f64,
    },

    Timeline {
        timeline: Timeline,
        actor: Option<UserSummary>,
        reason: TimelineReason,
    },

    ParticipantJoined {
        participant: Participant,
    },
    ParticipantLeft {
        #[serde(rename = "userId")]
        user_id: Uuid,
    },
    ParticipantUpdated {
        participant: Participant,
    },

    QueueUpdated {
        items: Vec<QueueEntry>,
        version: u64,
    },

    ChatMessage {
        message: ChatEntry,
    },
    ChatTyping {
        #[serde(rename = "userId")]
        user_id: Uuid,
        active: bool,
    },
    ChatPinned {
        message: ChatEntry,
        pinned: bool,
    },
    ChatRead {
        #[serde(rename = "userId")]
        user_id: Uuid,
        #[serde(rename = "throughMessageId")]
        through_message_id: Uuid,
    },

    Reaction {
        #[serde(rename = "userId")]
        user_id: Uuid,
        emoji: String,
        at: i64,
    },

    SkipVoteUpdate {
        votes: usize,
        needed: usize,
        voters: Vec<Uuid>,
    },

    VoicePeerJoined {
        #[serde(rename = "userId")]
        user_id: Uuid,
        /// Perfect-negotiation role, decided server-side so two peers can never
        /// both believe they are impolite (ADR 0006).
        polite: bool,
    },
    VoicePeerLeft {
        #[serde(rename = "userId")]
        user_id: Uuid,
    },
    VoiceSignal {
        from: Uuid,
        payload: serde_json::Value,
    },
    VoiceState {
        #[serde(rename = "userId")]
        user_id: Uuid,
        muted: bool,
        #[serde(rename = "inVoice")]
        in_voice: bool,
    },
    VoiceCapacity {
        #[serde(rename = "atCapacity")]
        at_capacity: bool,
        #[serde(rename = "maxPeers")]
        max_peers: usize,
    },

    RoomUpdated {
        room: RoomInfo,
    },
    /// Whose authority changed, and what it is now.
    ///
    /// Broadcast rather than sent to one connection: the room has a single
    /// fan-out path, and a role change has to reach the person it happened to
    /// even when they are connected to another node. Clients ignore any
    /// `userId` that is not their own. Nothing is disclosed by the broadcast —
    /// permissions are a pure function of a role everyone can already see in
    /// the participant list, and of the room settings.
    PermissionsUpdated {
        #[serde(rename = "userId")]
        user_id: Uuid,
        role: String,
        permissions: crate::rooms::permissions::Permissions,
    },

    Kicked {
        reason: KickReason,
    },

    Error {
        code: ErrorCode,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none", rename = "retryAfterMs")]
        retry_after_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TimelineReason {
    Intent,
    Advance,
    VoteSkip,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KickReason {
    RoomClosed,
    Banned,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthenticated,
    Forbidden,
    RateLimited,
    InvalidMessage,
    StaleVersion,
    RoomFull,
    NotFound,
    Internal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyPayload {
    /// `self` on the wire — the protocol schema names it that, but it is a
    /// keyword in Rust, so the field is `self_user` and renamed explicitly.
    /// Without this, `rename_all` emits `selfUser`, the client's schema
    /// rejects the frame, and `socket.ts` drops it silently: the room sits on
    /// "Joining…" forever with no error on either side.
    #[serde(rename = "self")]
    pub self_user: UserSummary,
    pub role: String,
    pub permissions: crate::rooms::permissions::Permissions,
    pub room: RoomInfo,
    pub timeline: Timeline,
    pub participants: Vec<Participant>,
    pub queue: Vec<QueueEntry>,
    pub recent_messages: Vec<ChatEntry>,
    pub pinned_messages: Vec<ChatEntry>,
    pub ice_servers: Vec<IceServer>,
    /// Seeds the clock estimate before the first ping lands.
    pub server_time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub topic: Option<String>,
    pub visibility: String,
    pub category: String,
    /// Who controls the room right now. Moves when the room changes hands.
    pub host_id: Uuid,
    /// Who created it. Never moves, and is what lets a returning creator
    /// reclaim a room that was auto-handed to someone else.
    pub owner_id: Option<Uuid>,
    /// Who the host nominated to inherit the room.
    pub successor_id: Option<Uuid>,
    pub created_at: i64,
    pub max_participants: i32,
    pub settings: RoomSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub user: UserSummary,
    pub role: String,
    pub joined_at: i64,
    pub in_voice: bool,
    pub muted: bool,
    pub drift_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub id: Uuid,
    /// How and where to play this item. Replaces the bare YouTube id: a room
    /// can now queue files and streams alongside YouTube videos.
    pub source: crate::media::MediaSource,
    pub title: String,
    pub channel_title: String,
    pub duration_seconds: i32,
    pub thumbnail_url: String,
    pub added_by: UserSummary,
    pub added_at: i64,
    pub position: f64,
}

impl QueueEntry {
    pub fn from_row(item: &QueueItem, added_by: UserSummary) -> Self {
        Self {
            id: item.id,
            source: item.source(),
            title: item.title.clone(),
            channel_title: item.channel_title.clone(),
            duration_seconds: item.duration_seconds,
            thumbnail_url: item.thumbnail_url.clone(),
            added_by,
            added_at: item.added_at.timestamp_millis(),
            position: item.position,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEntry {
    pub id: Uuid,
    pub author: UserSummary,
    pub body: String,
    pub sent_at: i64,
    pub edited_at: Option<i64>,
    pub reply_to: Option<Uuid>,
    pub pinned: bool,
    pub nonce: Option<String>,
    pub mentions: Vec<Uuid>,
    pub system: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// The synthetic author attached to system messages, so the client can render
/// them without a special case for a missing user.
pub fn system_author() -> UserSummary {
    UserSummary {
        id: Uuid::nil(),
        display_name: "Room".to_string(),
        avatar_url: None,
        initials: "R".to_string(),
        avatar_hue: 210,
        kind: "system".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_messages_use_a_tag_field() {
        let raw = r#"{"t":"ping","clientSent":1234.5}"#;
        let parsed: ClientMessage = serde_json::from_str(raw).unwrap();
        assert!(matches!(parsed, ClientMessage::Ping { client_sent } if client_sent == 1234.5));
    }

    #[test]
    fn sync_intents_carry_a_nested_action_tag() {
        let raw = r#"{"t":"sync_intent","action":{"kind":"seek","position":42.5},"version":7}"#;
        let parsed: ClientMessage = serde_json::from_str(raw).unwrap();
        match parsed {
            ClientMessage::SyncIntent { action, version } => {
                assert_eq!(version, 7);
                assert!(matches!(action, SyncAction::Seek { position } if position == 42.5));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn unit_variants_need_no_payload() {
        let parsed: ClientMessage = serde_json::from_str(r#"{"t":"voice_join"}"#).unwrap();
        assert!(matches!(parsed, ClientMessage::VoiceJoin));
    }

    #[test]
    fn unknown_message_types_are_rejected_rather_than_ignored() {
        assert!(serde_json::from_str::<ClientMessage>(r#"{"t":"drop_database"}"#).is_err());
        assert!(serde_json::from_str::<ClientMessage>(r#"{"nope":1}"#).is_err());
    }

    #[test]
    fn queue_add_defaults_play_next_to_false() {
        let parsed: ClientMessage =
            serde_json::from_str(r#"{"t":"queue_add","url":"dQw4w9WgXcQ"}"#).unwrap();
        match parsed {
            ClientMessage::QueueAdd { play_next, .. } => assert!(!play_next),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn queue_add_takes_any_url_not_just_a_youtube_id() {
        // The field is deliberately `url`, not `videoId`: a room queues files
        // and streams now, and the server decides how each one plays.
        for raw in [
            r#"{"t":"queue_add","url":"https://cdn.example.com/a.mp4"}"#,
            r#"{"t":"queue_add","url":"https://cdn.example.com/live.m3u8","playNext":true}"#,
        ] {
            assert!(serde_json::from_str::<ClientMessage>(raw).is_ok(), "failed on {raw}");
        }
    }

    #[test]
    fn clearing_a_successor_is_expressible_on_the_wire() {
        // `{"userId":null}` has to mean "no successor", which is a different
        // instruction from omitting the field in a partial update elsewhere.
        let parsed: ClientMessage =
            serde_json::from_str(r#"{"t":"designate_successor","userId":null}"#).unwrap();
        assert!(matches!(
            parsed,
            ClientMessage::DesignateSuccessor { user_id: None }
        ));
    }

    #[test]
    fn server_messages_serialize_with_camelcase_payloads() {
        let message = ServerMessage::Pong {
            client_sent: 1.0,
            server_time: 2.0,
        };
        let json = serde_json::to_string(&message).unwrap();
        assert!(json.contains(r#""t":"pong""#));
        assert!(json.contains(r#""clientSent""#));
        assert!(json.contains(r#""serverTime""#));
    }

    #[test]
    fn error_payload_omits_retry_after_when_absent() {
        let message = ServerMessage::Error {
            code: ErrorCode::Forbidden,
            message: "nope".into(),
            retry_after_ms: None,
        };
        let json = serde_json::to_string(&message).unwrap();
        assert!(!json.contains("retryAfterMs"));
    }
}

#[cfg(test)]
mod wire_names {
    use super::*;
    use crate::sync::Timeline;

    /// Two fields in this protocol are named after Rust keywords, so the struct
    /// fields carry different names and rely on `#[serde(rename)]` to restore
    /// the wire spelling. `rename_all = "camelCase"` silently produces
    /// `selfUser`/`loopCurrent` if that attribute is ever dropped, and the
    /// client reacts by discarding the frame in `socket.ts` rather than
    /// erroring — a room that sits on "Joining…" forever with a clean log on
    /// both sides. Assert the wire names directly.
    #[test]
    fn keyword_fields_keep_their_protocol_names() {
        let timeline = serde_json::to_value(Timeline::idle(0)).unwrap();
        assert!(timeline.get("loop").is_some(), "timeline lost `loop`");
        assert!(
            timeline.get("loopCurrent").is_none(),
            "timeline leaked the Rust field name"
        );

        let ready = ReadyPayload {
            self_user: system_author(),
            role: "guest".to_string(),
            permissions: crate::rooms::permissions::Permissions {
                can_control_playback: false,
                can_manage_queue: false,
                can_invite: false,
                can_kick: false,
                can_moderate_chat: false,
                can_edit_room: false,
                can_vote_skip: true,
                can_transfer_host: false,
                can_manage_roles: false,
                can_designate_successor: false,
                can_set_room_theme: false,
            },
            room: RoomInfo {
                id: uuid::Uuid::nil(),
                slug: "slug".to_string(),
                name: "room".to_string(),
                topic: None,
                visibility: "public".to_string(),
                category: "music".to_string(),
                host_id: uuid::Uuid::nil(),
                owner_id: None,
                successor_id: None,
                created_at: 0,
                max_participants: 25,
                settings: crate::db::rooms::RoomSettings::default(),
            },
            timeline: Timeline::idle(0),
            participants: Vec::new(),
            queue: Vec::new(),
            recent_messages: Vec::new(),
            pinned_messages: Vec::new(),
            ice_servers: Vec::new(),
            server_time: 0,
        };

        let value = serde_json::to_value(&ready).unwrap();
        assert!(value.get("self").is_some(), "ready lost `self`");
        assert!(
            value.get("selfUser").is_none(),
            "ready leaked the Rust field name"
        );

        // Printed so the JSON can be checked against the Zod schema directly.
        println!("{}", serde_json::to_string(&ready).unwrap());
    }
}
