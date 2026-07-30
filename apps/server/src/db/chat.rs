//! Chat persistence.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, PgExecutor, PgPool};
use uuid::Uuid;

/// Fields mirror the selected columns. Some are unread today; they are kept
/// because `FromRow` maps the whole row and a partial struct would silently
/// diverge from the query.
#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct ChatMessage {
    pub id: Uuid,
    pub room_id: Uuid,
    pub author_id: Option<Uuid>,
    pub body: String,
    pub sent_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub reply_to: Option<Uuid>,
    pub pinned: bool,
    pub system_kind: Option<String>,
    pub mentions: Vec<Uuid>,
}

const COLUMNS: &str =
    "id, room_id, author_id, body, sent_at, edited_at, reply_to, pinned, system_kind, mentions";

pub async fn insert(
    pool: &PgPool,
    room_id: Uuid,
    author_id: Uuid,
    body: &str,
    reply_to: Option<Uuid>,
    mentions: &[Uuid],
) -> sqlx::Result<ChatMessage> {
    sqlx::query_as::<_, ChatMessage>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO chat_messages (id, room_id, author_id, body, reply_to, mentions)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING {COLUMNS}"
    )))
    .bind(Uuid::now_v7())
    .bind(room_id)
    .bind(author_id)
    .bind(body)
    .bind(reply_to)
    .bind(mentions)
    .fetch_one(pool)
    .await
}

/// Generated messages ("Sam joined", "Skipped by vote"). Authorless by design —
/// attributing them to a user would let a client edit or delete them.
pub async fn insert_system(
    pool: &PgPool,
    room_id: Uuid,
    kind: &str,
    body: &str,
) -> sqlx::Result<ChatMessage> {
    sqlx::query_as::<_, ChatMessage>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO chat_messages (id, room_id, author_id, body, system_kind)
         VALUES ($1, $2, NULL, $3, $4)
         RETURNING {COLUMNS}"
    )))
    .bind(Uuid::now_v7())
    .bind(room_id)
    .bind(body)
    .bind(kind)
    .fetch_one(pool)
    .await
}

/// Newest `limit` messages, returned oldest-first so the caller can render
/// directly without reversing.
pub async fn recent<'e, E: PgExecutor<'e>>(
    executor: E,
    room_id: Uuid,
    limit: i64,
) -> sqlx::Result<Vec<ChatMessage>> {
    let mut rows = sqlx::query_as::<_, ChatMessage>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM chat_messages
         WHERE room_id = $1 AND deleted_at IS NULL
         ORDER BY sent_at DESC, id DESC
         LIMIT $2"
    )))
    .bind(room_id)
    .bind(limit)
    .fetch_all(executor)
    .await?;

    rows.reverse();
    Ok(rows)
}

/// Keyset pagination backwards from `before`. Offset paging would drift as new
/// messages arrive during a scroll.
pub async fn page_before(
    pool: &PgPool,
    room_id: Uuid,
    before: Uuid,
    limit: i64,
) -> sqlx::Result<Vec<ChatMessage>> {
    let mut rows = sqlx::query_as::<_, ChatMessage>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM chat_messages
         WHERE room_id = $1 AND deleted_at IS NULL AND id < $2
         ORDER BY sent_at DESC, id DESC
         LIMIT $3"
    )))
    .bind(room_id)
    .bind(before)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    rows.reverse();
    Ok(rows)
}

pub async fn pinned<'e, E: PgExecutor<'e>>(
    executor: E,
    room_id: Uuid,
) -> sqlx::Result<Vec<ChatMessage>> {
    sqlx::query_as::<_, ChatMessage>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM chat_messages
         WHERE room_id = $1 AND pinned AND deleted_at IS NULL
         ORDER BY sent_at DESC"
    )))
    .bind(room_id)
    .fetch_all(executor)
    .await
}

pub async fn set_pinned(
    pool: &PgPool,
    room_id: Uuid,
    message_id: Uuid,
    pinned: bool,
) -> sqlx::Result<Option<ChatMessage>> {
    sqlx::query_as::<_, ChatMessage>(sqlx::AssertSqlSafe(format!(
        "UPDATE chat_messages SET pinned = $3
         WHERE id = $1 AND room_id = $2 AND deleted_at IS NULL
         RETURNING {COLUMNS}"
    )))
    .bind(message_id)
    .bind(room_id)
    .bind(pinned)
    .fetch_optional(pool)
    .await
}

/// Soft delete — replies referencing this message keep working, and moderation
/// stays auditable.
pub async fn soft_delete(pool: &PgPool, room_id: Uuid, message_id: Uuid) -> sqlx::Result<bool> {
    let result = sqlx::query(
        "UPDATE chat_messages SET deleted_at = now()
         WHERE id = $1 AND room_id = $2 AND deleted_at IS NULL",
    )
    .bind(message_id)
    .bind(room_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Extract `@mentions` and resolve them to users who are actually in the room.
///
/// Resolving against membership rather than the global user table means a
/// mention cannot be used to probe for the existence of an account.
pub async fn resolve_mentions(
    pool: &PgPool,
    room_id: Uuid,
    body: &str,
) -> sqlx::Result<Vec<Uuid>> {
    let names = extract_mention_names(body);
    if names.is_empty() {
        return Ok(Vec::new());
    }

    sqlx::query_scalar::<_, Uuid>(
        "SELECT u.id FROM users u
         JOIN room_members m ON m.user_id = u.id
         WHERE m.room_id = $1 AND m.banned_at IS NULL AND lower(u.display_name) = ANY($2)",
    )
    .bind(room_id)
    .bind(&names)
    .fetch_all(pool)
    .await
}

/// Pull `@name` tokens out of a message body, lowercased.
///
/// Deliberately conservative: a mention runs to the end of the word, so
/// "@Anas!" resolves to "anas". Multi-word display names are matched by the
/// client sending the canonical form; this is the fallback path.
fn extract_mention_names(body: &str) -> Vec<String> {
    let mut names = Vec::new();
    for token in body.split_whitespace() {
        if let Some(rest) = token.strip_prefix('@') {
            let cleaned: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if cleaned.len() >= 2 {
                let lowered = cleaned.to_lowercase();
                if !names.contains(&lowered) {
                    names.push(lowered);
                }
            }
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::extract_mention_names;

    #[test]
    fn extracts_mentions_and_strips_punctuation() {
        assert_eq!(extract_mention_names("hey @anas how are you"), vec!["anas"]);
        assert_eq!(extract_mention_names("@Anas! and @sam?"), vec!["anas", "sam"]);
    }

    #[test]
    fn ignores_non_mentions() {
        assert!(extract_mention_names("email me at a@b.com").is_empty());
        assert!(extract_mention_names("no mentions here").is_empty());
        assert!(extract_mention_names("@a").is_empty(), "single char is too short");
    }

    #[test]
    fn deduplicates_repeated_mentions() {
        assert_eq!(extract_mention_names("@sam @sam @SAM"), vec!["sam"]);
    }
}
