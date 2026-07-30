//! Room HTTP endpoints.

use crate::{
    auth::{CurrentUser, MaybeUser, password},
    db::{
        self,
        rooms::{DirectorySort, NewRoom, RoomPatch, RoomSettings},
    },
    error::{AppError, AppResult},
    ratelimit,
    rooms::permissions::{self, Role},
    state::AppState,
    util,
    youtube::YouTube,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_public).post(create_room))
        .route("/mine", get(list_mine))
        .route("/{id}", get(get_room).patch(update_room))
        .route("/{id}", delete(delete_room))
        .route("/{id}/join", post(join_room))
        .route("/{id}/invites", post(create_invite))
        .route("/{id}/history", get(room_history))
        .route("/{id}/messages", get(chat_history))
        .route("/{id}/messages/{message_id}", delete(delete_message))
        .route("/by-slug/{slug}", get(get_room_by_slug))
        .route("/join-by-code/{code}", post(join_by_code))
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRoomRequest {
    name: String,
    #[serde(default)]
    topic: Option<String>,
    #[serde(default = "default_visibility")]
    visibility: String,
    #[serde(default = "default_category")]
    category: String,
    #[serde(default)]
    password: Option<String>,
    #[serde(default = "default_max_participants")]
    max_participants: i32,
    #[serde(default)]
    allow_guest_control: bool,
    #[serde(default = "default_true")]
    allow_guest_queue: bool,
    #[serde(default)]
    initial_video_ids: Vec<String>,
}

fn default_visibility() -> String {
    "private".into()
}
fn default_category() -> String {
    "general".into()
}
const fn default_max_participants() -> i32 {
    25
}
const fn default_true() -> bool {
    true
}

const VISIBILITIES: [&str; 3] = ["public", "private", "unlisted"];
const CATEGORIES: [&str; 7] = [
    "general",
    "anime",
    "gaming",
    "programming",
    "music",
    "movies",
    "education",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoomResponse {
    id: Uuid,
    slug: String,
    name: String,
    topic: Option<String>,
    visibility: String,
    category: String,
    host: db::users::UserSummary,
    max_participants: i32,
    active_participants: i32,
    has_password: bool,
    settings: RoomSettings,
    created_at: i64,
    /// The caller's role, so the UI can render the right controls immediately
    /// rather than waiting for the socket to say.
    your_role: Option<String>,
}

async fn create_room(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Json(body): Json<CreateRoomRequest>,
) -> AppResult<Json<RoomResponse>> {
    // Guests can join anything but cannot own rooms — an anonymous owner
    // cannot be contacted, moderated or held responsible for a public room.
    if claims.is_guest() {
        return Err(AppError::Forbidden(
            "Sign in with Google to create a room.",
        ));
    }

    let mut redis = state.redis.clone();
    let decision = ratelimit::check(
        &mut redis,
        "room_create",
        &claims.sub.to_string(),
        state.config.limits.rooms_per_hour,
        std::time::Duration::from_secs(3600),
    )
    .await;

    if !decision.allowed {
        return Err(AppError::RateLimited {
            retry_after_ms: decision.retry_after_ms,
        });
    }

    let name = body.name.trim();
    if name.chars().count() < 2 || name.chars().count() > 60 {
        return Err(AppError::field("name", "Use between 2 and 60 characters."));
    }
    if !VISIBILITIES.contains(&body.visibility.as_str()) {
        return Err(AppError::field("visibility", "Unknown visibility."));
    }
    if !CATEGORIES.contains(&body.category.as_str()) {
        return Err(AppError::field("category", "Unknown category."));
    }
    if !(2..=100).contains(&body.max_participants) {
        return Err(AppError::field("maxParticipants", "Choose between 2 and 100."));
    }

    let password_hash = match body.password.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(raw) if raw.len() < 4 => {
            return Err(AppError::field("password", "Use at least 4 characters."));
        }
        Some(raw) => Some(password::hash_password(raw).map_err(AppError::Internal)?),
        None => None,
    };

    let settings = RoomSettings {
        allow_guest_control: body.allow_guest_control,
        allow_guest_queue: body.allow_guest_queue,
        ..RoomSettings::default()
    };

    // Slug collisions are astronomically unlikely (31^12) but a retry is two
    // lines and turns "unlucky" into "invisible".
    let mut created = None;
    for _ in 0..5 {
        let slug = util::generate_room_slug();
        match db::rooms::create(
            &state.db,
            &slug,
            NewRoom {
                name,
                topic: body.topic.as_deref().map(str::trim).filter(|t| !t.is_empty()),
                visibility: &body.visibility,
                category: &body.category,
                host_id: claims.sub,
                password_hash: password_hash.as_deref(),
                max_participants: body.max_participants,
                settings: settings.clone(),
            },
        )
        .await
        {
            Ok(room) => {
                created = Some(room);
                break;
            }
            Err(sqlx::Error::Database(err)) if err.code().as_deref() == Some("23505") => continue,
            Err(other) => return Err(other.into()),
        }
    }

    let room = created.ok_or_else(|| {
        AppError::Internal(anyhow::anyhow!("exhausted room slug attempts"))
    })?;

    // Seed the queue from a template, best-effort: a failed lookup must not
    // undo a successfully created room.
    if !body.initial_video_ids.is_empty() {
        let youtube = YouTube::new(state.config.youtube.clone(), state.http.clone());
        let mut redis = state.redis.clone();

        for raw in body.initial_video_ids.iter().take(50) {
            let Some(video_id) = util::parse_video_id(raw) else {
                continue;
            };
            let metadata = youtube.video(&mut redis, &video_id).await;
            let _ = db::queue::add(
                &state.db,
                room.id,
                db::queue::NewQueueItem {
                    video_id: metadata.video_id,
                    title: metadata.title,
                    channel_title: metadata.channel_title,
                    duration_seconds: metadata.duration_seconds,
                    thumbnail_url: metadata.thumbnail_url,
                    added_by: claims.sub,
                },
                false,
            )
            .await;
        }
    }

    db::history::audit(
        &state.db,
        Some(claims.sub),
        Some(room.id),
        "room.created",
        serde_json::json!({ "visibility": room.visibility }),
    )
    .await;

    let host = db::users::find_by_id(&state.db, room.host_id)
        .await?
        .ok_or_else(|| AppError::not_found("host"))?;

    Ok(Json(to_response(&room, &host, Some(Role::Host))))
}

fn to_response(
    room: &db::rooms::Room,
    host: &db::users::User,
    your_role: Option<Role>,
) -> RoomResponse {
    RoomResponse {
        id: room.id,
        slug: room.slug.clone(),
        name: room.name.clone(),
        topic: room.topic.clone(),
        visibility: room.visibility.clone(),
        category: room.category.clone(),
        host: db::users::UserSummary::from(host),
        max_participants: room.max_participants,
        active_participants: room.active_participants,
        // Never leak the hash — only whether one exists.
        has_password: room.password_hash.is_some(),
        settings: room.settings.0.clone(),
        created_at: room.created_at.timestamp_millis(),
        your_role: your_role.map(|r| r.as_str().to_string()),
    }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async fn get_room(
    State(state): State<AppState>,
    MaybeUser(claims): MaybeUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<RoomResponse>> {
    let room = db::rooms::find_by_id(&state.db, id)
        .await?
        .ok_or_else(|| AppError::not_found("room"))?;
    respond_with_room(&state, room, claims).await
}

async fn get_room_by_slug(
    State(state): State<AppState>,
    MaybeUser(claims): MaybeUser,
    Path(slug): Path<String>,
) -> AppResult<Json<RoomResponse>> {
    let room = db::rooms::find_by_slug(&state.db, &slug)
        .await?
        .ok_or_else(|| AppError::not_found("room"))?;
    respond_with_room(&state, room, claims).await
}

async fn respond_with_room(
    state: &AppState,
    room: db::rooms::Room,
    claims: Option<crate::auth::tokens::AccessClaims>,
) -> AppResult<Json<RoomResponse>> {
    let host = db::users::find_by_id(&state.db, room.host_id)
        .await?
        .ok_or_else(|| AppError::not_found("host"))?;

    let your_role = match &claims {
        None => None,
        Some(claims) => db::rooms::find_membership(&state.db, room.id, claims.sub)
            .await?
            .map(|m| Role::parse(&m.role)),
    };

    Ok(Json(to_response(&room, &host, your_role)))
}

#[derive(Debug, Deserialize)]
struct DirectoryQuery {
    #[serde(default)]
    sort: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    page: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryItem {
    id: Uuid,
    slug: String,
    name: String,
    topic: Option<String>,
    category: String,
    host: db::users::UserSummary,
    participant_count: i32,
    max_participants: i32,
    has_password: bool,
    now_playing: Option<NowPlaying>,
    created_at: i64,
    trending_score: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NowPlaying {
    video_id: String,
    title: String,
    thumbnail_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Paginated<T> {
    items: Vec<T>,
    next_page: Option<i64>,
}

/// Public directory. Open to anonymous callers by design — browsing rooms is
/// how the product gets discovered.
async fn list_public(
    State(state): State<AppState>,
    Query(query): Query<DirectoryQuery>,
) -> AppResult<Json<Paginated<DirectoryItem>>> {
    let limit = query.limit.unwrap_or(24).clamp(1, 50);
    let page = query.page.unwrap_or(0).max(0);
    let sort = DirectorySort::parse(query.sort.as_deref().unwrap_or("trending"));

    let category = query
        .category
        .as_deref()
        .filter(|c| CATEGORIES.contains(c));

    let search = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty() && q.len() <= 80);

    // Fetch one extra to know whether another page exists, without a COUNT(*).
    let rows = db::rooms::list_directory(
        &state.db,
        sort,
        category,
        search,
        limit + 1,
        page * limit,
    )
    .await?;

    let has_more = rows.len() as i64 > limit;
    let items = rows
        .into_iter()
        .take(limit as usize)
        .map(|row| DirectoryItem {
            now_playing: match (row.now_playing_video_id, row.now_playing_title) {
                (Some(video_id), Some(title)) => Some(NowPlaying {
                    video_id,
                    title,
                    thumbnail_url: row.now_playing_thumbnail.unwrap_or_default(),
                }),
                _ => None,
            },
            host: db::users::UserSummary {
                id: row.host_id,
                display_name: row.host_display_name.clone(),
                avatar_url: row.host_avatar_url.clone(),
                initials: util::initials(&row.host_display_name),
                avatar_hue: util::avatar_hue(&row.host_id),
                kind: row.host_kind,
            },
            id: row.id,
            slug: row.slug,
            name: row.name,
            topic: row.topic,
            category: row.category,
            participant_count: row.active_participants,
            max_participants: row.max_participants,
            has_password: row.has_password,
            created_at: row.created_at.timestamp_millis(),
            trending_score: row.trending_score,
        })
        .collect();

    Ok(Json(Paginated {
        items,
        next_page: has_more.then_some(page + 1),
    }))
}

async fn list_mine(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<Vec<RoomResponse>>> {
    let rooms = db::rooms::list_rooms_for_user(&state.db, claims.sub, 50).await?;

    let host_ids: Vec<Uuid> = rooms.iter().map(|r| r.host_id).collect();
    let hosts = db::users::find_many(&state.db, &host_ids).await?;
    let lookup: std::collections::HashMap<Uuid, &db::users::User> =
        hosts.iter().map(|u| (u.id, u)).collect();

    let items = rooms
        .iter()
        .filter_map(|room| {
            lookup.get(&room.host_id).map(|host| {
                let role = (room.host_id == claims.sub).then_some(Role::Host);
                to_response(room, host, role)
            })
        })
        .collect();

    Ok(Json(items))
}

async fn room_history(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    // History is a member-only view: it reveals what a private room watched.
    db::rooms::find_membership(&state.db, id, claims.sub)
        .await?
        .ok_or(AppError::Forbidden("You are not in this room."))?;

    let items = db::queue::recent_history(&state.db, id, 100).await?;
    Ok(Json(
        items
            .into_iter()
            .map(|item| {
                serde_json::json!({
                    "videoId": item.video_id,
                    "title": item.title,
                    "thumbnailUrl": item.thumbnail_url,
                    "durationSeconds": item.duration_seconds,
                    "playedAt": item.played_at.map(|t| t.timestamp_millis()),
                })
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatHistoryQuery {
    /// Keyset cursor: return messages older than this id.
    #[serde(default)]
    before: Option<Uuid>,
    #[serde(default)]
    limit: Option<i64>,
}

/// Older chat, for scrolling back past the window the socket delivered.
///
/// Keyset paged rather than offset paged: with messages arriving during a
/// scroll, offsets shift under the reader and duplicate or skip rows.
async fn chat_history(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Path(id): Path<Uuid>,
    Query(query): Query<ChatHistoryQuery>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    db::rooms::find_membership(&state.db, id, claims.sub)
        .await?
        .ok_or(AppError::Forbidden("You are not in this room."))?;

    let limit = query.limit.unwrap_or(50).clamp(1, 100);

    let rows = match query.before {
        Some(before) => db::chat::page_before(&state.db, id, before, limit).await?,
        None => db::chat::recent(&state.db, id, limit).await?,
    };

    let author_ids: Vec<Uuid> = rows.iter().filter_map(|m| m.author_id).collect();
    let authors = db::users::find_many(&state.db, &author_ids).await?;
    let lookup: std::collections::HashMap<Uuid, db::users::UserSummary> = authors
        .iter()
        .map(|u| (u.id, db::users::UserSummary::from(u)))
        .collect();

    Ok(Json(
        rows.into_iter()
            .map(|row| {
                serde_json::json!({
                    "id": row.id,
                    "author": row.author_id.and_then(|a| lookup.get(&a).cloned()),
                    "body": row.body,
                    "sentAt": row.sent_at.timestamp_millis(),
                    "replyTo": row.reply_to,
                    "pinned": row.pinned,
                    "mentions": row.mentions,
                    "system": row.system_kind,
                })
            })
            .collect(),
    ))
}

async fn delete_message(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Path((id, message_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<serde_json::Value>> {
    let room = db::rooms::find_by_id(&state.db, id)
        .await?
        .ok_or_else(|| AppError::not_found("room"))?;

    let role = current_role(&state, id, claims.sub).await?;
    if !permissions::resolve(role, &room.settings.0).can_moderate_chat {
        return Err(AppError::Forbidden("You cannot delete messages here."));
    }

    if !db::chat::soft_delete(&state.db, id, message_id).await? {
        return Err(AppError::not_found("message"));
    }

    db::history::audit(
        &state.db,
        Some(claims.sub),
        Some(id),
        "chat.message_deleted",
        serde_json::json!({ "message": message_id }),
    )
    .await;

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinRequest {
    #[serde(default)]
    password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JoinResponse {
    room_id: Uuid,
    slug: String,
    role: String,
}

async fn join_room(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<JoinRequest>,
) -> AppResult<Json<JoinResponse>> {
    let room = db::rooms::find_by_id(&state.db, id)
        .await?
        .ok_or_else(|| AppError::not_found("room"))?;

    if let Some(membership) = db::rooms::find_membership(&state.db, id, claims.sub).await?
        && membership.banned_at.is_some()
    {
        return Err(AppError::Forbidden("You have been removed from this room."));
    }

    // Rate-limit password attempts per user per room: this is the one place an
    // attacker can guess a secret.
    if let Some(hash) = &room.password_hash {
        let mut redis = state.redis.clone();
        let decision = ratelimit::check(
            &mut redis,
            "room_password",
            &format!("{}:{}", claims.sub, id),
            10,
            std::time::Duration::from_secs(300),
        )
        .await;

        if !decision.allowed {
            return Err(AppError::RateLimited {
                retry_after_ms: decision.retry_after_ms,
            });
        }

        let supplied = body.password.as_deref().unwrap_or("");
        if !password::verify_password(supplied, hash) {
            return Err(AppError::field("password", "That password is not right."));
        }
    }

    // Reject at the door rather than after the socket opens, so the UI can say
    // "this room is full" on the join screen instead of flashing into a room
    // and being ejected.
    if let Some(live) = state.hub.get(id)
        && live.participant_count().await >= room.max_participants as usize
    {
        return Err(AppError::RoomFull);
    }

    let default_role = if claims.is_guest() { "guest" } else { "member" };
    let membership =
        db::rooms::upsert_membership(&state.db, id, claims.sub, default_role).await?;

    Ok(Json(JoinResponse {
        room_id: room.id,
        slug: room.slug,
        role: membership.role,
    }))
}

async fn join_by_code(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Path(code): Path<String>,
) -> AppResult<Json<JoinResponse>> {
    let invite = db::rooms::redeem_invite(&state.db, &code)
        .await?
        .ok_or_else(|| AppError::not_found("invite"))?;

    let room = db::rooms::find_by_id(&state.db, invite.room_id)
        .await?
        .ok_or_else(|| AppError::not_found("room"))?;

    let default_role = if claims.is_guest() { "guest" } else { "member" };
    let membership =
        db::rooms::upsert_membership(&state.db, room.id, claims.sub, default_role).await?;

    Ok(Json(JoinResponse {
        room_id: room.id,
        slug: room.slug,
        role: membership.role,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInviteRequest {
    #[serde(default)]
    expires_in_hours: Option<i64>,
    #[serde(default)]
    max_uses: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InviteResponse {
    code: String,
    url: String,
    expires_at: Option<i64>,
    max_uses: Option<i32>,
}

async fn create_invite(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<CreateInviteRequest>,
) -> AppResult<Json<InviteResponse>> {
    let room = db::rooms::find_by_id(&state.db, id)
        .await?
        .ok_or_else(|| AppError::not_found("room"))?;

    let role = current_role(&state, id, claims.sub).await?;
    let perms = permissions::resolve(role, &room.settings.0);
    if !perms.can_invite {
        return Err(AppError::Forbidden("You cannot invite people to this room."));
    }

    let expires_at = body
        .expires_in_hours
        .filter(|h| *h > 0)
        .map(|hours| chrono::Utc::now() + chrono::Duration::hours(hours.min(24 * 30)));

    let code = util::random_token(12);
    let invite = db::rooms::create_invite(
        &state.db,
        id,
        claims.sub,
        &code,
        expires_at,
        body.max_uses.filter(|n| *n > 0),
    )
    .await?;

    Ok(Json(InviteResponse {
        url: format!("{}/invite/{}", state.config.web_origin, invite.code),
        code: invite.code,
        expires_at: invite.expires_at.map(|t| t.timestamp_millis()),
        max_uses: invite.max_uses,
    }))
}

// ---------------------------------------------------------------------------
// Update / delete
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRoomRequest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    topic: Option<Option<String>>,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    max_participants: Option<i32>,
    #[serde(default, deserialize_with = "double_option")]
    password: Option<Option<String>>,
    #[serde(default)]
    allow_guest_control: Option<bool>,
    #[serde(default)]
    allow_guest_queue: Option<bool>,
    #[serde(default)]
    vote_skip_ratio: Option<f64>,
    #[serde(default)]
    auto_advance: Option<bool>,
    #[serde(default)]
    theme: Option<String>,
}

/// Distinguish "field absent" from "field set to null" — the difference between
/// leaving a password alone and removing it.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}

async fn update_room(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateRoomRequest>,
) -> AppResult<Json<RoomResponse>> {
    let room = db::rooms::find_by_id(&state.db, id)
        .await?
        .ok_or_else(|| AppError::not_found("room"))?;

    let role = current_role(&state, id, claims.sub).await?;
    if !permissions::resolve(role, &room.settings.0).can_edit_room {
        return Err(AppError::Forbidden("Only the host can change room settings."));
    }

    if let Some(name) = &body.name
        && (name.trim().chars().count() < 2 || name.trim().chars().count() > 60)
    {
        return Err(AppError::field("name", "Use between 2 and 60 characters."));
    }
    if let Some(visibility) = &body.visibility
        && !VISIBILITIES.contains(&visibility.as_str())
    {
        return Err(AppError::field("visibility", "Unknown visibility."));
    }
    if let Some(category) = &body.category
        && !CATEGORIES.contains(&category.as_str())
    {
        return Err(AppError::field("category", "Unknown category."));
    }
    if let Some(ratio) = body.vote_skip_ratio
        && !(0.0..=1.0).contains(&ratio)
    {
        return Err(AppError::field("voteSkipRatio", "Use a value between 0 and 1."));
    }

    let mut settings = room.settings.0.clone();
    if let Some(v) = body.allow_guest_control {
        settings.allow_guest_control = v;
    }
    if let Some(v) = body.allow_guest_queue {
        settings.allow_guest_queue = v;
    }
    if let Some(v) = body.vote_skip_ratio {
        settings.vote_skip_ratio = v;
    }
    if let Some(v) = body.auto_advance {
        settings.auto_advance = v;
    }
    if let Some(v) = body.theme {
        settings.theme = v.chars().take(32).collect();
    }

    let password_hash = match body.password {
        None => None,
        Some(None) => Some(None),
        Some(Some(raw)) if raw.trim().len() < 4 => {
            return Err(AppError::field("password", "Use at least 4 characters."));
        }
        Some(Some(raw)) => Some(Some(
            password::hash_password(raw.trim()).map_err(AppError::Internal)?,
        )),
    };

    let updated = db::rooms::update(
        &state.db,
        id,
        RoomPatch {
            name: body.name.map(|n| n.trim().to_owned()),
            topic: body
                .topic
                .map(|t| t.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())),
            visibility: body.visibility,
            category: body.category,
            max_participants: body.max_participants.filter(|n| (2..=100).contains(n)),
            password_hash,
            settings: Some(settings),
        },
    )
    .await?;

    // Live sockets must see the change without a reload.
    if let Some(live) = state.hub.get(id) {
        let mut info = live.info.write().await;
        info.name = updated.name.clone();
        info.topic = updated.topic.clone();
        info.visibility = updated.visibility.clone();
        info.category = updated.category.clone();
        info.settings = updated.settings.0.clone();
        info.max_participants = updated.max_participants;
        let snapshot = info.clone();
        drop(info);

        state
            .hub
            .broadcast(
                &live,
                &crate::realtime::protocol::ServerMessage::RoomUpdated { room: snapshot },
            )
            .await;
    }

    let host = db::users::find_by_id(&state.db, updated.host_id)
        .await?
        .ok_or_else(|| AppError::not_found("host"))?;

    Ok(Json(to_response(&updated, &host, Some(role))))
}

async fn delete_room(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let room = db::rooms::find_by_id(&state.db, id)
        .await?
        .ok_or_else(|| AppError::not_found("room"))?;

    if room.host_id != claims.sub {
        return Err(AppError::Forbidden("Only the host can delete this room."));
    }

    db::rooms::soft_delete(&state.db, id).await?;
    db::history::audit(
        &state.db,
        Some(claims.sub),
        Some(id),
        "room.deleted",
        serde_json::json!({}),
    )
    .await;

    // Tell everyone still inside before the socket drops, so the UI can explain
    // what happened instead of showing a generic disconnect.
    if let Some(live) = state.hub.get(id) {
        state
            .hub
            .broadcast(
                &live,
                &crate::realtime::protocol::ServerMessage::Kicked {
                    reason: crate::realtime::protocol::KickReason::RoomClosed,
                },
            )
            .await;
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn current_role(state: &AppState, room_id: Uuid, user_id: Uuid) -> AppResult<Role> {
    Ok(db::rooms::find_membership(&state.db, room_id, user_id)
        .await?
        .map(|m| Role::parse(&m.role))
        .unwrap_or(Role::Guest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlists_match_the_database_check_constraints() {
        // These must stay in step with migrations/20260730000001_init.sql, or a
        // valid-looking request fails at the database with a 500.
        assert_eq!(VISIBILITIES.len(), 3);
        assert!(VISIBILITIES.contains(&"public"));
        assert!(VISIBILITIES.contains(&"private"));
        assert!(VISIBILITIES.contains(&"unlisted"));

        assert_eq!(CATEGORIES.len(), 7);
        for expected in [
            "general",
            "anime",
            "gaming",
            "programming",
            "music",
            "movies",
            "education",
        ] {
            assert!(CATEGORIES.contains(&expected), "missing {expected}");
        }
    }

    #[test]
    fn update_request_distinguishes_absent_from_null() {
        let absent: UpdateRoomRequest = serde_json::from_str("{}").unwrap();
        assert!(absent.password.is_none(), "absent means leave unchanged");

        let cleared: UpdateRoomRequest = serde_json::from_str(r#"{"password":null}"#).unwrap();
        assert_eq!(cleared.password, Some(None), "null means remove");

        let set: UpdateRoomRequest = serde_json::from_str(r#"{"password":"hunter2"}"#).unwrap();
        assert_eq!(set.password, Some(Some("hunter2".to_string())));
    }

    #[test]
    fn create_request_defaults_to_a_private_general_room() {
        let body: CreateRoomRequest = serde_json::from_str(r#"{"name":"Movie night"}"#).unwrap();
        assert_eq!(body.visibility, "private");
        assert_eq!(body.category, "general");
        assert_eq!(body.max_participants, 25);
        assert!(body.allow_guest_queue);
        assert!(!body.allow_guest_control, "playback stays with the host by default");
    }
}
