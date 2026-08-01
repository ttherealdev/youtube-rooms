//! The shared queue.
//!
//! Ordering uses fractional positions so a drag-and-drop reorder is a single
//! UPDATE (see `util::fractional_position`). The reorder path takes a row lock
//! on the room's items so two people dragging at once cannot interleave into an
//! inconsistent order.

use crate::{
    media::{MediaSource, SourceKind},
    util,
};
use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgExecutor, PgPool};
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
pub struct QueueItem {
    pub id: Uuid,
    pub room_id: Uuid,
    /// Set only for YouTube rows; the schema enforces that pairing.
    pub video_id: Option<String>,
    pub source_kind: String,
    pub source_url: String,
    pub title: String,
    pub channel_title: String,
    pub duration_seconds: i32,
    pub thumbnail_url: String,
    pub added_by: Option<Uuid>,
    pub added_at: DateTime<Utc>,
    pub position: f64,
    pub played_at: Option<DateTime<Utc>>,
}

impl QueueItem {
    /// Rebuild the playable source from its stored columns.
    ///
    /// A row whose `source_kind` we no longer recognise — written by a newer
    /// node during a rolling deploy — degrades to a plain file rather than
    /// failing the whole queue read.
    pub fn source(&self) -> MediaSource {
        MediaSource {
            kind: SourceKind::parse(&self.source_kind).unwrap_or(SourceKind::File),
            url: self.source_url.clone(),
            video_id: self.video_id.clone(),
        }
    }
}

const COLUMNS: &str = "id, room_id, video_id, source_kind, source_url, title, channel_title, \
                       duration_seconds, thumbnail_url, added_by, added_at, position, played_at";

#[derive(Debug, Clone)]
pub struct NewQueueItem {
    pub source: MediaSource,
    pub title: String,
    pub channel_title: String,
    pub duration_seconds: i32,
    pub thumbnail_url: String,
    pub added_by: Uuid,
}

pub async fn list_pending<'e, E: PgExecutor<'e>>(
    executor: E,
    room_id: Uuid,
) -> sqlx::Result<Vec<QueueItem>> {
    sqlx::query_as::<_, QueueItem>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM queue_items
         WHERE room_id = $1 AND played_at IS NULL
         ORDER BY position"
    )))
    .bind(room_id)
    .fetch_all(executor)
    .await
}

pub async fn find<'e, E: PgExecutor<'e>>(
    executor: E,
    item_id: Uuid,
) -> sqlx::Result<Option<QueueItem>> {
    sqlx::query_as::<_, QueueItem>(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM queue_items WHERE id = $1")))
        .bind(item_id)
        .fetch_optional(executor)
        .await
}

/// Append to the tail, or insert directly after the head when `play_next`.
pub async fn add(
    pool: &PgPool,
    room_id: Uuid,
    item: NewQueueItem,
    play_next: bool,
) -> sqlx::Result<QueueItem> {
    let mut tx = pool.begin().await?;

    let position = if play_next {
        let head: Vec<f64> = sqlx::query_scalar(
            "SELECT position FROM queue_items
             WHERE room_id = $1 AND played_at IS NULL
             ORDER BY position LIMIT 2
             FOR UPDATE",
        )
        .bind(room_id)
        .fetch_all(&mut *tx)
        .await?;

        util::fractional_position(head.first().copied(), head.get(1).copied())
    } else {
        let tail: Option<f64> = sqlx::query_scalar(
            "SELECT max(position) FROM queue_items WHERE room_id = $1 AND played_at IS NULL",
        )
        .bind(room_id)
        .fetch_one(&mut *tx)
        .await?;

        util::fractional_position(tail, None)
    };

    let created = insert_one(&mut tx, room_id, &item, position).await?;

    tx.commit().await?;
    Ok(created)
}

/// Append many items in one transaction — the playlist import path.
///
/// Positions are handed out from a single starting point rather than by
/// re-reading the tail per row, so importing 500 channels is one round trip
/// worth of contention instead of 500.
pub async fn add_many(
    pool: &PgPool,
    room_id: Uuid,
    items: &[NewQueueItem],
) -> sqlx::Result<Vec<QueueItem>> {
    if items.is_empty() {
        return Ok(Vec::new());
    }

    let mut tx = pool.begin().await?;

    let tail: Option<f64> = sqlx::query_scalar(
        "SELECT max(position) FROM queue_items WHERE room_id = $1 AND played_at IS NULL",
    )
    .bind(room_id)
    .fetch_one(&mut *tx)
    .await?;

    let mut position = util::fractional_position(tail, None);
    let mut created = Vec::with_capacity(items.len());

    for item in items {
        created.push(insert_one(&mut tx, room_id, item, position).await?);
        // Same spacing `fractional_position` uses when appending to a tail, so
        // a later insert-between still has room to land.
        position += 1024.0;
    }

    tx.commit().await?;
    Ok(created)
}

async fn insert_one(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    room_id: Uuid,
    item: &NewQueueItem,
    position: f64,
) -> sqlx::Result<QueueItem> {
    sqlx::query_as::<_, QueueItem>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO queue_items
             (id, room_id, video_id, source_kind, source_url, title, channel_title,
              duration_seconds, thumbnail_url, added_by, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING {COLUMNS}"
    )))
    .bind(Uuid::now_v7())
    .bind(room_id)
    .bind(item.source.video_id.as_deref())
    .bind(item.source.kind.as_str())
    .bind(&item.source.url)
    .bind(&item.title)
    .bind(&item.channel_title)
    .bind(item.duration_seconds)
    .bind(&item.thumbnail_url)
    .bind(item.added_by)
    .bind(position)
    .fetch_one(&mut **tx)
    .await
}

pub async fn remove(pool: &PgPool, room_id: Uuid, item_id: Uuid) -> sqlx::Result<bool> {
    let result = sqlx::query("DELETE FROM queue_items WHERE id = $1 AND room_id = $2")
        .bind(item_id)
        .bind(room_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() == 1)
}

pub async fn clear_pending(pool: &PgPool, room_id: Uuid) -> sqlx::Result<u64> {
    let result =
        sqlx::query("DELETE FROM queue_items WHERE room_id = $1 AND played_at IS NULL")
            .bind(room_id)
            .execute(pool)
            .await?;
    Ok(result.rows_affected())
}

/// Move an item to `to_index` in the current pending ordering.
///
/// The whole pending set is locked `FOR UPDATE` first. Without that, two
/// concurrent drags can each compute a midpoint against a list the other is
/// about to change, and the result is an order neither user asked for.
pub async fn move_item(
    pool: &PgPool,
    room_id: Uuid,
    item_id: Uuid,
    to_index: usize,
) -> sqlx::Result<Vec<QueueItem>> {
    let mut tx = pool.begin().await?;

    let items = sqlx::query_as::<_, QueueItem>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM queue_items
         WHERE room_id = $1 AND played_at IS NULL
         ORDER BY position
         FOR UPDATE"
    )))
    .bind(room_id)
    .fetch_all(&mut *tx)
    .await?;

    let Some(from_index) = items.iter().position(|i| i.id == item_id) else {
        tx.rollback().await?;
        return Ok(items);
    };

    // Neighbours in the list *without* the moved item, which is what determines
    // the midpoint. Computing against the original list is the classic
    // off-by-one that makes an item refuse to move one slot down.
    let mut remaining: Vec<&QueueItem> = items.iter().collect();
    remaining.remove(from_index);

    let target = to_index.min(remaining.len());
    let before = target.checked_sub(1).and_then(|i| remaining.get(i)).map(|i| i.position);
    let after = remaining.get(target).map(|i| i.position);

    let new_position = util::fractional_position(before, after);

    // Precision floor reached — renumber the list and retry the placement.
    if let (Some(b), Some(a)) = (before, after)
        && util::needs_rebalance(b, a)
    {
        for (idx, item) in remaining.iter().enumerate() {
            let normalized = (idx as f64 + 1.0) * 1024.0;
            sqlx::query("UPDATE queue_items SET position = $2 WHERE id = $1")
                .bind(item.id)
                .bind(normalized)
                .execute(&mut *tx)
                .await?;
        }
        let rebalanced = (target as f64 + 0.5) * 1024.0;
        sqlx::query("UPDATE queue_items SET position = $2 WHERE id = $1")
            .bind(item_id)
            .bind(rebalanced)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("UPDATE queue_items SET position = $2 WHERE id = $1")
            .bind(item_id)
            .bind(new_position)
            .execute(&mut *tx)
            .await?;
    }

    let reordered = sqlx::query_as::<_, QueueItem>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM queue_items
         WHERE room_id = $1 AND played_at IS NULL
         ORDER BY position"
    )))
    .bind(room_id)
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(reordered)
}

/// Randomise the pending order. Positions are rewritten wholesale, which is
/// acceptable because shuffling is explicit and rare.
pub async fn shuffle(pool: &PgPool, room_id: Uuid) -> sqlx::Result<Vec<QueueItem>> {
    use rand::seq::SliceRandom;

    let mut tx = pool.begin().await?;

    let mut ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM queue_items WHERE room_id = $1 AND played_at IS NULL
         ORDER BY position FOR UPDATE",
    )
    .bind(room_id)
    .fetch_all(&mut *tx)
    .await?;

    ids.shuffle(&mut rand::rng());

    for (idx, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE queue_items SET position = $2 WHERE id = $1")
            .bind(id)
            .bind((idx as f64 + 1.0) * 1024.0)
            .execute(&mut *tx)
            .await?;
    }

    let reordered = sqlx::query_as::<_, QueueItem>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM queue_items
         WHERE room_id = $1 AND played_at IS NULL
         ORDER BY position"
    )))
    .bind(room_id)
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(reordered)
}

/// Take the next item and mark it played, atomically.
///
/// `FOR UPDATE SKIP LOCKED` means two nodes racing to advance the same room
/// cannot hand out the same item twice.
pub async fn pop_next(pool: &PgPool, room_id: Uuid) -> sqlx::Result<Option<QueueItem>> {
    sqlx::query_as::<_, QueueItem>(sqlx::AssertSqlSafe(format!(
        "UPDATE queue_items SET played_at = now()
         WHERE id = (
             SELECT id FROM queue_items
             WHERE room_id = $1 AND played_at IS NULL
             ORDER BY position
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         )
         RETURNING {COLUMNS}"
    )))
    .bind(room_id)
    .fetch_optional(pool)
    .await
}

pub async fn mark_played(pool: &PgPool, item_id: Uuid) -> sqlx::Result<()> {
    sqlx::query("UPDATE queue_items SET played_at = now() WHERE id = $1 AND played_at IS NULL")
        .bind(item_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Most recently played items — the room's history panel.
pub async fn recent_history(
    pool: &PgPool,
    room_id: Uuid,
    limit: i64,
) -> sqlx::Result<Vec<QueueItem>> {
    sqlx::query_as::<_, QueueItem>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM queue_items
         WHERE room_id = $1 AND played_at IS NOT NULL
         ORDER BY played_at DESC
         LIMIT $2"
    )))
    .bind(room_id)
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Put a played item back at the front — powers "previous".
pub async fn requeue_front(pool: &PgPool, room_id: Uuid, item_id: Uuid) -> sqlx::Result<()> {
    let head: Option<f64> = sqlx::query_scalar(
        "SELECT min(position) FROM queue_items WHERE room_id = $1 AND played_at IS NULL",
    )
    .bind(room_id)
    .fetch_one(pool)
    .await?;

    sqlx::query("UPDATE queue_items SET played_at = NULL, position = $2 WHERE id = $1")
        .bind(item_id)
        .bind(util::fractional_position(None, head))
        .execute(pool)
        .await?;
    Ok(())
}
