//! Rooms, membership and the public directory.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgExecutor, PgPool, Postgres, Transaction};
use uuid::Uuid;

/// Fields mirror the selected columns. Some are unread today; they are kept
/// because `FromRow` maps the whole row and a partial struct would silently
/// diverge from the query.
#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct Room {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub topic: Option<String>,
    pub visibility: String,
    pub category: String,
    pub host_id: Uuid,
    /// Permanent creator. Unlike `host_id` this never moves on an automatic
    /// handover, which is what lets a returning creator reclaim their room.
    pub owner_id: Option<Uuid>,
    /// Who the host nominated to inherit the room.
    pub successor_id: Option<Uuid>,
    /// When the last participant left, or NULL while anyone is present.
    pub empty_since: Option<DateTime<Utc>>,
    pub password_hash: Option<String>,
    pub max_participants: i32,
    pub settings: sqlx::types::Json<RoomSettings>,
    pub active_participants: i32,
    pub created_at: DateTime<Utc>,
    pub last_active_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoomSettings {
    #[serde(default)]
    pub allow_guest_control: bool,
    #[serde(default = "default_true")]
    pub allow_guest_queue: bool,
    #[serde(default = "default_skip_ratio")]
    pub vote_skip_ratio: f64,
    #[serde(default = "default_true")]
    pub auto_advance: bool,
    #[serde(default)]
    pub shuffle: bool,
    /// Key into the shared theme registry. The host picks it; every client in
    /// the room renders with it.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// `light` or `dark`. Kept separate from the theme so a host can pick a
    /// palette without also forcing everyone into a mode.
    #[serde(default = "default_theme_mode")]
    pub theme_mode: String,
}

const fn default_true() -> bool {
    true
}
fn default_skip_ratio() -> f64 {
    0.5
}
fn default_theme() -> String {
    "default".to_string()
}
fn default_theme_mode() -> String {
    "dark".to_string()
}

impl Default for RoomSettings {
    fn default() -> Self {
        Self {
            allow_guest_control: false,
            allow_guest_queue: true,
            vote_skip_ratio: 0.5,
            auto_advance: true,
            shuffle: false,
            theme: default_theme(),
            theme_mode: default_theme_mode(),
        }
    }
}

const ROOM_COLUMNS: &str = "id, slug, name, topic, visibility, category, host_id, owner_id, \
                            successor_id, empty_since, password_hash, max_participants, settings, \
                            active_participants, created_at, last_active_at";

#[derive(Debug, Clone)]
pub struct NewRoom<'a> {
    pub name: &'a str,
    pub topic: Option<&'a str>,
    pub visibility: &'a str,
    pub category: &'a str,
    pub host_id: Uuid,
    pub password_hash: Option<&'a str>,
    pub max_participants: i32,
    pub settings: RoomSettings,
}

/// Create a room and seat its host in one transaction — a room without a host
/// row is unreachable, so the two writes must not be able to diverge.
pub async fn create(pool: &PgPool, slug: &str, new_room: NewRoom<'_>) -> sqlx::Result<Room> {
    let mut tx: Transaction<'_, Postgres> = pool.begin().await?;

    let room = sqlx::query_as::<_, Room>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO rooms (id, slug, name, topic, visibility, category, host_id, owner_id,
                            password_hash, max_participants, settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)
         RETURNING {ROOM_COLUMNS}"
    )))
    .bind(Uuid::now_v7())
    .bind(slug)
    .bind(new_room.name)
    .bind(new_room.topic)
    .bind(new_room.visibility)
    .bind(new_room.category)
    .bind(new_room.host_id)
    .bind(new_room.password_hash)
    .bind(new_room.max_participants)
    .bind(sqlx::types::Json(&new_room.settings))
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'host')",
    )
    .bind(room.id)
    .bind(new_room.host_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(room)
}

pub async fn find_by_id<'e, E: PgExecutor<'e>>(
    executor: E,
    id: Uuid,
) -> sqlx::Result<Option<Room>> {
    sqlx::query_as::<_, Room>(sqlx::AssertSqlSafe(format!(
        "SELECT {ROOM_COLUMNS} FROM rooms WHERE id = $1 AND deleted_at IS NULL"
    )))
    .bind(id)
    .fetch_optional(executor)
    .await
}

pub async fn find_by_slug<'e, E: PgExecutor<'e>>(
    executor: E,
    slug: &str,
) -> sqlx::Result<Option<Room>> {
    sqlx::query_as::<_, Room>(sqlx::AssertSqlSafe(format!(
        "SELECT {ROOM_COLUMNS} FROM rooms WHERE slug = $1 AND deleted_at IS NULL"
    )))
    .bind(slug)
    .fetch_optional(executor)
    .await
}

#[derive(Debug, Default)]
pub struct RoomPatch {
    pub name: Option<String>,
    pub topic: Option<Option<String>>,
    pub visibility: Option<String>,
    pub category: Option<String>,
    pub max_participants: Option<i32>,
    /// `Some(None)` clears the password; `None` leaves it untouched.
    pub password_hash: Option<Option<String>>,
    pub settings: Option<RoomSettings>,
}

/// `COALESCE`-based partial update. Every field is optional, and the
/// distinction between "not provided" and "explicitly cleared" is preserved by
/// passing separate sentinel flags for the nullable columns.
pub async fn update(pool: &PgPool, room_id: Uuid, patch: RoomPatch) -> sqlx::Result<Room> {
    sqlx::query_as::<_, Room>(sqlx::AssertSqlSafe(format!(
        "UPDATE rooms SET
             name             = COALESCE($2, name),
             topic            = CASE WHEN $3 THEN $4 ELSE topic END,
             visibility       = COALESCE($5, visibility),
             category         = COALESCE($6, category),
             max_participants = COALESCE($7, max_participants),
             password_hash    = CASE WHEN $8 THEN $9 ELSE password_hash END,
             settings         = COALESCE($10, settings)
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING {ROOM_COLUMNS}"
    )))
    .bind(room_id)
    .bind(patch.name)
    .bind(patch.topic.is_some())
    .bind(patch.topic.flatten())
    .bind(patch.visibility)
    .bind(patch.category)
    .bind(patch.max_participants)
    .bind(patch.password_hash.is_some())
    .bind(patch.password_hash.flatten())
    .bind(patch.settings.map(sqlx::types::Json))
    .fetch_one(pool)
    .await
}

pub async fn soft_delete(pool: &PgPool, room_id: Uuid) -> sqlx::Result<()> {
    sqlx::query("UPDATE rooms SET deleted_at = now() WHERE id = $1")
        .bind(room_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn touch_activity<'e, E: PgExecutor<'e>>(
    executor: E,
    room_id: Uuid,
    active_participants: i32,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE rooms SET last_active_at = now(), active_participants = $2 WHERE id = $1",
    )
    .bind(room_id)
    .bind(active_participants)
    .execute(executor)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/// Fields mirror the selected columns. Some are unread today; they are kept
/// because `FromRow` maps the whole row and a partial struct would silently
/// diverge from the query.
#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct Membership {
    pub room_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub banned_at: Option<DateTime<Utc>>,
}

pub async fn find_membership<'e, E: PgExecutor<'e>>(
    executor: E,
    room_id: Uuid,
    user_id: Uuid,
) -> sqlx::Result<Option<Membership>> {
    sqlx::query_as::<_, Membership>(
        "SELECT room_id, user_id, role, joined_at, banned_at
         FROM room_members WHERE room_id = $1 AND user_id = $2",
    )
    .bind(room_id)
    .bind(user_id)
    .fetch_optional(executor)
    .await
}

/// Idempotent join. Re-entering a room preserves the role you already had —
/// a moderator who reconnects must not be demoted to member.
pub async fn upsert_membership(
    pool: &PgPool,
    room_id: Uuid,
    user_id: Uuid,
    default_role: &str,
) -> sqlx::Result<Membership> {
    sqlx::query_as::<_, Membership>(
        "INSERT INTO room_members (room_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, user_id) DO UPDATE SET last_seen_at = now()
         RETURNING room_id, user_id, role, joined_at, banned_at",
    )
    .bind(room_id)
    .bind(user_id)
    .bind(default_role)
    .fetch_one(pool)
    .await
}

pub async fn set_role(
    pool: &PgPool,
    room_id: Uuid,
    user_id: Uuid,
    role: &str,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE room_members SET role = $3 WHERE room_id = $1 AND user_id = $2")
        .bind(room_id)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await?;
    Ok(())
}

/// Hand the room to someone else.
///
/// Demote-then-promote inside a transaction, because `room_members_single_host_idx`
/// forbids two hosts existing even momentarily.
/// Hand the room to someone else.
///
/// `permanent` distinguishes the two ways a room changes hands, and getting it
/// wrong is user-visible. An explicit transfer is a decision — the outgoing
/// host meant it, so ownership moves and they do not silently take the room
/// back next time they open it. An automatic promotion, when a host simply
/// closes their laptop, is custody rather than ownership: `owner_id` stays put
/// so the creator reclaims the room on their return.
pub async fn transfer_host(
    pool: &PgPool,
    room_id: Uuid,
    from_user: Uuid,
    to_user: Uuid,
    permanent: bool,
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;

    sqlx::query("UPDATE room_members SET role = 'cohost' WHERE room_id = $1 AND user_id = $2")
        .bind(room_id)
        .bind(from_user)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'host')
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = 'host'",
    )
    .bind(room_id)
    .bind(to_user)
    .execute(&mut *tx)
    .await?;

    // Clearing the successor matters: a nomination is about *this* host's
    // departure, and leaving it in place would let a stale name inherit a room
    // from someone who never chose them.
    if permanent {
        sqlx::query("UPDATE rooms SET host_id = $2, owner_id = $2, successor_id = NULL WHERE id = $1")
            .bind(room_id)
            .bind(to_user)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("UPDATE rooms SET host_id = $2, successor_id = NULL WHERE id = $1")
            .bind(room_id)
            .bind(to_user)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await
}

/// Record the host's nomination, or clear it with `None`.
pub async fn set_successor(
    pool: &PgPool,
    room_id: Uuid,
    successor: Option<Uuid>,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE rooms SET successor_id = $2 WHERE id = $1")
        .bind(room_id)
        .bind(successor)
        .execute(pool)
        .await?;
    Ok(())
}

/// Start, or cancel, the empty-room grace period.
///
/// Called on every join and leave. `COALESCE` on the way in is what makes the
/// grace period a real one: two people leaving in quick succession must not
/// restart the clock, or a busy room that empties in stages never closes.
pub async fn set_emptiness(pool: &PgPool, room_id: Uuid, is_empty: bool) -> sqlx::Result<()> {
    if is_empty {
        sqlx::query(
            "UPDATE rooms SET empty_since = COALESCE(empty_since, now())
             WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(room_id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query("UPDATE rooms SET empty_since = NULL WHERE id = $1")
            .bind(room_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// Close every room that has been empty longer than the grace period.
///
/// Returns the rooms it closed so the caller can tear down their runtime state.
/// The `active_participants = 0` guard is belt-and-braces against a stale
/// `empty_since` on a room that quietly refilled.
pub async fn close_expired_empty_rooms(
    pool: &PgPool,
    grace: std::time::Duration,
) -> sqlx::Result<Vec<Uuid>> {
    sqlx::query_scalar(
        "UPDATE rooms
            SET deleted_at = now()
          WHERE deleted_at IS NULL
            AND empty_since IS NOT NULL
            AND active_participants = 0
            AND empty_since < now() - make_interval(secs => $1)
        RETURNING id",
    )
    .bind(grace.as_secs_f64())
    .fetch_all(pool)
    .await
}

pub async fn ban(pool: &PgPool, room_id: Uuid, user_id: Uuid, by: Uuid) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE room_members SET banned_at = now(), banned_by = $3
         WHERE room_id = $1 AND user_id = $2",
    )
    .bind(room_id)
    .bind(user_id)
    .bind(by)
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, FromRow)]
pub struct DirectoryRow {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub topic: Option<String>,
    pub category: String,
    pub host_id: Uuid,
    pub host_display_name: String,
    pub host_avatar_url: Option<String>,
    pub host_kind: String,
    pub active_participants: i32,
    pub max_participants: i32,
    pub has_password: bool,
    pub now_playing_video_id: Option<String>,
    pub now_playing_title: Option<String>,
    pub now_playing_thumbnail: Option<String>,
    pub created_at: DateTime<Utc>,
    pub trending_score: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectorySort {
    Trending,
    Newest,
    Active,
}

impl DirectorySort {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "newest" => Self::Newest,
            "active" => Self::Active,
            _ => Self::Trending,
        }
    }

    fn order_clause(self) -> &'static str {
        match self {
            Self::Trending => "trending_score DESC, r.last_active_at DESC",
            Self::Newest => "r.created_at DESC",
            Self::Active => "r.active_participants DESC, r.last_active_at DESC",
        }
    }
}

/// Public room listing.
///
/// `trending_score` is a Hacker-News-style decay: occupancy over the age of the
/// last activity, so a room that filled up an hour ago loses to one filling up
/// now. The `+2` floor keeps a brand-new empty room from dividing by ~0 and
/// rocketing to the top.
pub async fn list_directory(
    pool: &PgPool,
    sort: DirectorySort,
    category: Option<&str>,
    query: Option<&str>,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<DirectoryRow>> {
    let sql = format!(
        "SELECT
             r.id, r.slug, r.name, r.topic, r.category,
             r.host_id,
             u.display_name AS host_display_name,
             u.avatar_url   AS host_avatar_url,
             u.kind         AS host_kind,
             r.active_participants,
             r.max_participants,
             (r.password_hash IS NOT NULL) AS has_password,
             q.video_id      AS now_playing_video_id,
             q.title         AS now_playing_title,
             q.thumbnail_url AS now_playing_thumbnail,
             r.created_at,
             (r.active_participants + 1)::float8
                 / power(
                     (EXTRACT(EPOCH FROM (now() - r.last_active_at)) / 3600.0) + 2.0,
                     1.5
                   ) AS trending_score
         FROM rooms r
         JOIN users u ON u.id = r.host_id
         LEFT JOIN LATERAL (
             SELECT video_id, title, thumbnail_url
             FROM queue_items
             WHERE room_id = r.id AND played_at IS NOT NULL
             ORDER BY played_at DESC
             LIMIT 1
         ) q ON true
         WHERE r.visibility = 'public'
           AND r.deleted_at IS NULL
           AND ($1::text IS NULL OR r.category = $1)
           AND ($2::text IS NULL OR to_tsvector('english', r.name || ' ' || coalesce(r.topic, ''))
                                    @@ websearch_to_tsquery('english', $2))
         ORDER BY {}
         LIMIT $3 OFFSET $4",
        sort.order_clause()
    );

    // Audited per sqlx's `SqlSafeStr` contract: the only interpolation is
    // `order_clause()`, which returns one of three compile-time literals chosen
    // by an enum. User input reaches this query exclusively through binds.
    sqlx::query_as::<_, DirectoryRow>(sqlx::AssertSqlSafe(sql))
        .bind(category)
        .bind(query)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
}

pub async fn list_rooms_for_user(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
) -> sqlx::Result<Vec<Room>> {
    sqlx::query_as::<_, Room>(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM rooms r
         JOIN room_members m ON m.room_id = r.id
         WHERE m.user_id = $1 AND r.deleted_at IS NULL AND m.banned_at IS NULL
         ORDER BY r.last_active_at DESC
         LIMIT $2",
        ROOM_COLUMNS
            .split(", ")
            .map(|c| format!("r.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    )))
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/// Fields mirror the selected columns. Some are unread today; they are kept
/// because `FromRow` maps the whole row and a partial struct would silently
/// diverge from the query.
#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct Invite {
    pub id: Uuid,
    pub room_id: Uuid,
    pub code: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub max_uses: Option<i32>,
    pub uses: i32,
}

pub async fn create_invite(
    pool: &PgPool,
    room_id: Uuid,
    created_by: Uuid,
    code: &str,
    expires_at: Option<DateTime<Utc>>,
    max_uses: Option<i32>,
) -> sqlx::Result<Invite> {
    sqlx::query_as::<_, Invite>(
        "INSERT INTO room_invites (id, room_id, code, created_by, expires_at, max_uses)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, room_id, code, expires_at, max_uses, uses",
    )
    .bind(Uuid::now_v7())
    .bind(room_id)
    .bind(code)
    .bind(created_by)
    .bind(expires_at)
    .bind(max_uses)
    .fetch_one(pool)
    .await
}

/// Redeem an invite atomically.
///
/// The expiry and use-count checks live in the `WHERE` clause of the `UPDATE`
/// so that two people redeeming the last use concurrently cannot both succeed.
pub async fn redeem_invite(pool: &PgPool, code: &str) -> sqlx::Result<Option<Invite>> {
    sqlx::query_as::<_, Invite>(
        "UPDATE room_invites SET uses = uses + 1
         WHERE code = $1
           AND (expires_at IS NULL OR expires_at > now())
           AND (max_uses IS NULL OR uses < max_uses)
         RETURNING id, room_id, code, expires_at, max_uses, uses",
    )
    .bind(code)
    .fetch_optional(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_through_json_with_defaults() {
        let json = r#"{"allowGuestControl":true}"#;
        let settings: RoomSettings = serde_json::from_str(json).unwrap();
        assert!(settings.allow_guest_control);
        // Everything unspecified must fall back, not fail.
        assert!(settings.allow_guest_queue);
        assert_eq!(settings.theme, "default");
        assert_eq!(settings.theme_mode, "dark");
        assert!((settings.vote_skip_ratio - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn directory_sort_defaults_to_trending_for_unknown_input() {
        assert_eq!(DirectorySort::parse("newest"), DirectorySort::Newest);
        assert_eq!(DirectorySort::parse("active"), DirectorySort::Active);
        assert_eq!(DirectorySort::parse("nonsense"), DirectorySort::Trending);
    }

    #[test]
    fn patch_distinguishes_absent_from_cleared() {
        let untouched = RoomPatch::default();
        assert!(untouched.topic.is_none());

        let cleared = RoomPatch { topic: Some(None), ..Default::default() };
        assert!(cleared.topic.is_some());
        assert!(cleared.topic.flatten().is_none());
    }
}
