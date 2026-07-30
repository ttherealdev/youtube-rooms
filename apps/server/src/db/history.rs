//! Per-user watch history, bookmarks and favourites.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
pub struct WatchHistoryEntry {
    pub video_id: String,
    pub title: String,
    pub thumbnail_url: String,
    pub room_id: Option<Uuid>,
    pub room_name: Option<String>,
    pub position_seconds: f64,
    pub duration_seconds: i32,
    pub watched_at: DateTime<Utc>,
}

/// Record or advance a user's position in a video.
///
/// One row per (user, video): rewatching updates in place, so the "continue
/// watching" rail never shows the same title twice. The position only moves
/// forward — a user who rewinds to catch a line has not un-watched the video.
pub struct WatchProgress<'a> {
    pub room_id: Option<Uuid>,
    pub video_id: &'a str,
    pub title: &'a str,
    pub thumbnail_url: &'a str,
    pub position_seconds: f64,
    pub duration_seconds: i32,
}

pub async fn record_watch(
    pool: &PgPool,
    user_id: Uuid,
    progress: WatchProgress<'_>,
) -> sqlx::Result<()> {
    let WatchProgress {
        room_id,
        video_id,
        title,
        thumbnail_url,
        position_seconds,
        duration_seconds,
    } = progress;

    sqlx::query(
        "INSERT INTO watch_history
             (id, user_id, room_id, video_id, title, thumbnail_url,
              position_seconds, duration_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, video_id) DO UPDATE SET
             room_id          = EXCLUDED.room_id,
             title            = EXCLUDED.title,
             thumbnail_url    = EXCLUDED.thumbnail_url,
             position_seconds = GREATEST(watch_history.position_seconds, EXCLUDED.position_seconds),
             duration_seconds = EXCLUDED.duration_seconds,
             watched_at       = now()",
    )
    .bind(Uuid::now_v7())
    .bind(user_id)
    .bind(room_id)
    .bind(video_id)
    .bind(title)
    .bind(thumbnail_url)
    .bind(position_seconds)
    .bind(duration_seconds)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn recent_watches(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
) -> sqlx::Result<Vec<WatchHistoryEntry>> {
    sqlx::query_as::<_, WatchHistoryEntry>(
        "SELECT h.video_id, h.title, h.thumbnail_url, h.room_id, r.name AS room_name,
                h.position_seconds, h.duration_seconds, h.watched_at
         FROM watch_history h
         LEFT JOIN rooms r ON r.id = h.room_id
         WHERE h.user_id = $1
         ORDER BY h.watched_at DESC
         LIMIT $2",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Videos the user started but did not finish.
///
/// The 5%–92% window excludes both "barely started" (noise) and "effectively
/// finished" (nobody wants to resume a video at the credits).
pub async fn continue_watching(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
) -> sqlx::Result<Vec<WatchHistoryEntry>> {
    sqlx::query_as::<_, WatchHistoryEntry>(
        "SELECT h.video_id, h.title, h.thumbnail_url, h.room_id, r.name AS room_name,
                h.position_seconds, h.duration_seconds, h.watched_at
         FROM watch_history h
         LEFT JOIN rooms r ON r.id = h.room_id
         WHERE h.user_id = $1
           AND h.duration_seconds > 0
           AND h.position_seconds > h.duration_seconds * 0.05
           AND h.position_seconds < h.duration_seconds * 0.92
         ORDER BY h.watched_at DESC
         LIMIT $2",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

#[derive(Debug, Clone, FromRow)]
pub struct Bookmark {
    pub id: Uuid,
    pub video_id: String,
    pub title: String,
    pub thumbnail_url: String,
    pub position_seconds: Option<f64>,
    pub note: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub async fn add_bookmark(
    pool: &PgPool,
    user_id: Uuid,
    video_id: &str,
    title: &str,
    thumbnail_url: &str,
    position_seconds: Option<f64>,
    note: Option<&str>,
) -> sqlx::Result<Bookmark> {
    sqlx::query_as::<_, Bookmark>(
        "INSERT INTO bookmarks
             (id, user_id, video_id, title, thumbnail_url, position_seconds, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, video_id, coalesce(position_seconds, -1))
         DO UPDATE SET note = EXCLUDED.note
         RETURNING id, video_id, title, thumbnail_url, position_seconds, note, created_at",
    )
    .bind(Uuid::now_v7())
    .bind(user_id)
    .bind(video_id)
    .bind(title)
    .bind(thumbnail_url)
    .bind(position_seconds)
    .bind(note)
    .fetch_one(pool)
    .await
}

pub async fn list_bookmarks(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
) -> sqlx::Result<Vec<Bookmark>> {
    sqlx::query_as::<_, Bookmark>(
        "SELECT id, video_id, title, thumbnail_url, position_seconds, note, created_at
         FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

pub async fn remove_bookmark(pool: &PgPool, user_id: Uuid, id: Uuid) -> sqlx::Result<bool> {
    let result = sqlx::query("DELETE FROM bookmarks WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn set_favorite(
    pool: &PgPool,
    user_id: Uuid,
    room_id: Uuid,
    favorite: bool,
) -> sqlx::Result<()> {
    if favorite {
        sqlx::query(
            "INSERT INTO room_favorites (user_id, room_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(user_id)
        .bind(room_id)
        .execute(pool)
        .await?;
    } else {
        sqlx::query("DELETE FROM room_favorites WHERE user_id = $1 AND room_id = $2")
            .bind(user_id)
            .bind(room_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// Aggregate counters for the profile page.
#[derive(Debug, Clone, FromRow, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStats {
    pub videos_watched: i64,
    pub rooms_joined: i64,
    pub rooms_hosted: i64,
    pub messages_sent: i64,
    /// Total watch time in seconds, approximated by furthest position reached.
    pub watch_seconds: f64,
}

pub async fn user_stats(pool: &PgPool, user_id: Uuid) -> sqlx::Result<UserStats> {
    sqlx::query_as::<_, UserStats>(
        "SELECT
            (SELECT count(*) FROM watch_history WHERE user_id = $1)                    AS videos_watched,
            (SELECT count(*) FROM room_members  WHERE user_id = $1)                    AS rooms_joined,
            (SELECT count(*) FROM rooms WHERE host_id = $1 AND deleted_at IS NULL)     AS rooms_hosted,
            (SELECT count(*) FROM chat_messages WHERE author_id = $1
                                                  AND deleted_at IS NULL)              AS messages_sent,
            (SELECT coalesce(sum(position_seconds), 0)::float8
               FROM watch_history WHERE user_id = $1)                                  AS watch_seconds",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
}

/// Append-only operational record. Failures here are logged, never propagated —
/// an audit write must not be able to fail a user action.
pub async fn audit(
    pool: &PgPool,
    actor_id: Option<Uuid>,
    room_id: Option<Uuid>,
    action: &str,
    metadata: serde_json::Value,
) {
    let result = sqlx::query(
        "INSERT INTO audit_log (id, actor_id, room_id, action, metadata)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::now_v7())
    .bind(actor_id)
    .bind(room_id)
    .bind(action)
    .bind(metadata)
    .execute(pool)
    .await;

    if let Err(error) = result {
        tracing::warn!(%action, ?error, "failed to write audit log entry");
    }
}
