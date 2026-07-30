//! User records and session tokens.

use crate::util;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgExecutor, PgPool};
use uuid::Uuid;

/// Mirrors the `users` row. `google_sub` and `email` are read by the auth
/// paths only and must never reach `UserSummary`.
#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
pub struct User {
    pub id: Uuid,
    pub kind: String,
    pub google_sub: Option<String>,
    pub email: Option<String>,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

/// The public projection of a user. This is the only shape that crosses the
/// wire — `email` and `google_sub` never leave the server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    pub id: Uuid,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub initials: String,
    pub avatar_hue: u16,
    pub kind: String,
}

impl From<&User> for UserSummary {
    fn from(user: &User) -> Self {
        Self {
            id: user.id,
            display_name: user.display_name.clone(),
            avatar_url: user.avatar_url.clone(),
            initials: util::initials(&user.display_name),
            avatar_hue: util::avatar_hue(&user.id),
            kind: user.kind.clone(),
        }
    }
}

impl From<User> for UserSummary {
    fn from(user: User) -> Self {
        Self::from(&user)
    }
}

const USER_COLUMNS: &str =
    "id, kind, google_sub, email, display_name, avatar_url, created_at, last_seen_at";

pub async fn find_by_id<'e, E: PgExecutor<'e>>(
    executor: E,
    id: Uuid,
) -> sqlx::Result<Option<User>> {
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(format!("SELECT {USER_COLUMNS} FROM users WHERE id = $1")))
        .bind(id)
        .fetch_optional(executor)
        .await
}

pub async fn find_many<'e, E: PgExecutor<'e>>(
    executor: E,
    ids: &[Uuid],
) -> sqlx::Result<Vec<User>> {
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_COLUMNS} FROM users WHERE id = ANY($1)"
    )))
    .bind(ids)
    .fetch_all(executor)
    .await
}

pub async fn create_guest(pool: &PgPool, display_name: &str) -> sqlx::Result<User> {
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO users (id, kind, display_name)
         VALUES ($1, 'guest', $2)
         RETURNING {USER_COLUMNS}"
    )))
    .bind(Uuid::now_v7())
    .bind(display_name)
    .fetch_one(pool)
    .await
}

/// Create or update the local record for a Google identity.
///
/// Keyed on `google_sub`, never on email — Google reassigns addresses within
/// Workspace domains, and matching on email would hand one person's account to
/// another.
pub async fn upsert_google_user(
    pool: &PgPool,
    google_sub: &str,
    email: Option<&str>,
    display_name: &str,
    avatar_url: Option<&str>,
) -> sqlx::Result<User> {
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO users (id, kind, google_sub, email, display_name, avatar_url)
         VALUES ($1, 'google', $2, $3, $4, $5)
         ON CONFLICT (google_sub) DO UPDATE SET
             email        = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             avatar_url   = EXCLUDED.avatar_url,
             last_seen_at = now()
         RETURNING {USER_COLUMNS}"
    )))
    .bind(Uuid::now_v7())
    .bind(google_sub)
    .bind(email)
    .bind(display_name)
    .bind(avatar_url)
    .fetch_one(pool)
    .await
}

pub async fn rename(pool: &PgPool, user_id: Uuid, display_name: &str) -> sqlx::Result<User> {
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(format!(
        "UPDATE users SET display_name = $2 WHERE id = $1 RETURNING {USER_COLUMNS}"
    )))
    .bind(user_id)
    .bind(display_name)
    .fetch_one(pool)
    .await
}

pub async fn touch_last_seen<'e, E: PgExecutor<'e>>(
    executor: E,
    user_id: Uuid,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE users SET last_seen_at = now() WHERE id = $1")
        .bind(user_id)
        .execute(executor)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, FromRow)]
pub struct RefreshToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub family_id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub consumed_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

pub async fn insert_refresh_token(
    pool: &PgPool,
    user_id: Uuid,
    token_hash: &str,
    family_id: Uuid,
    expires_at: DateTime<Utc>,
    user_agent: Option<&str>,
) -> sqlx::Result<Uuid> {
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id)
    .bind(user_id)
    .bind(token_hash)
    .bind(family_id)
    .bind(expires_at)
    .bind(user_agent)
    .execute(pool)
    .await?;
    Ok(id)
}

pub async fn find_refresh_token(
    pool: &PgPool,
    token_hash: &str,
) -> sqlx::Result<Option<RefreshToken>> {
    sqlx::query_as::<_, RefreshToken>(
        "SELECT id, user_id, family_id, expires_at, consumed_at, revoked_at
         FROM refresh_tokens WHERE token_hash = $1",
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await
}

/// Mark a token used. Returns false if it was already consumed, which is the
/// signal that someone is replaying a stolen token.
pub async fn consume_refresh_token(pool: &PgPool, id: Uuid) -> sqlx::Result<bool> {
    let result = sqlx::query(
        "UPDATE refresh_tokens SET consumed_at = now()
         WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Kill every token descended from one login. Called on reuse detection and on
/// explicit "sign out everywhere".
pub async fn revoke_family(pool: &PgPool, family_id: Uuid) -> sqlx::Result<u64> {
    let result = sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now()
         WHERE family_id = $1 AND revoked_at IS NULL",
    )
    .bind(family_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Housekeeping for expired rows. Run from the background sweeper.
pub async fn purge_expired_tokens(pool: &PgPool) -> sqlx::Result<u64> {
    let result = sqlx::query("DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'")
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// Guests accumulate: every invite-link visitor creates a row. Reap the ones
/// that never joined anything and have not been seen for a while.
pub async fn purge_stale_guests(pool: &PgPool) -> sqlx::Result<u64> {
    let result = sqlx::query(
        "DELETE FROM users
         WHERE kind = 'guest'
           AND last_seen_at < now() - interval '30 days'
           AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.user_id = users.id)
           AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.host_id = users.id)",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_derives_presentation_fields_and_hides_private_ones() {
        let user = User {
            id: Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap(),
            kind: "google".into(),
            google_sub: Some("sub-123".into()),
            email: Some("anas@example.com".into()),
            display_name: "Anas Mohamed".into(),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: Utc::now(),
        };

        let summary = UserSummary::from(&user);
        assert_eq!(summary.initials, "AM");
        assert!(summary.avatar_hue < 360);

        let json = serde_json::to_string(&summary).unwrap();
        assert!(!json.contains("anas@example.com"), "email must not be serialized");
        assert!(!json.contains("sub-123"), "google_sub must not be serialized");
    }
}
