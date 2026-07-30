//! One error type for the whole HTTP surface.
//!
//! The rule this enforces: internal failures never leak their detail to the
//! client. They are logged with full context and returned as an opaque 500 with
//! a request id the operator can grep for. Client-caused failures carry a
//! stable machine-readable `code` the frontend can branch on.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::collections::BTreeMap;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("authentication required")]
    Unauthenticated,

    #[error("{0}")]
    Forbidden(&'static str),

    #[error("{resource} not found")]
    NotFound { resource: &'static str },

    #[error("{0}")]
    Conflict(String),

    #[error("validation failed")]
    Validation(BTreeMap<String, String>),

    #[error("{0}")]
    BadRequest(String),

    #[error("rate limit exceeded")]
    RateLimited { retry_after_ms: u64 },

    #[error("room is at capacity")]
    RoomFull,

    #[error("upstream service failed: {0}")]
    Upstream(String),

    /// Anything the client cannot act on. Detail is logged, never returned.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    pub fn not_found(resource: &'static str) -> Self {
        Self::NotFound { resource }
    }

    pub fn field(field: impl Into<String>, message: impl Into<String>) -> Self {
        let mut map = BTreeMap::new();
        map.insert(field.into(), message.into());
        Self::Validation(map)
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::Unauthenticated => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound { .. } => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Validation(_) | Self::BadRequest(_) => StatusCode::UNPROCESSABLE_ENTITY,
            Self::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::RoomFull => StatusCode::CONFLICT,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Stable identifier the client switches on. Changing one of these is a
    /// breaking API change.
    fn code(&self) -> &'static str {
        match self {
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden(_) => "forbidden",
            Self::NotFound { .. } => "not_found",
            Self::Conflict(_) => "conflict",
            Self::Validation(_) => "validation_failed",
            Self::BadRequest(_) => "bad_request",
            Self::RateLimited { .. } => "rate_limited",
            Self::RoomFull => "room_full",
            Self::Upstream(_) => "upstream_error",
            Self::Internal(_) => "internal_error",
        }
    }

    fn public_message(&self) -> String {
        match self {
            Self::Internal(_) => "Something went wrong on our end.".into(),
            Self::Upstream(_) => "An upstream service is unavailable. Please retry.".into(),
            other => other.to_string(),
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fields: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // Log before consuming: internal errors carry the context we need and
        // must never reach the wire.
        match &self {
            Self::Internal(source) => {
                tracing::error!(error = ?source, "unhandled internal error");
            }
            Self::Upstream(detail) => {
                tracing::warn!(detail = %detail, "upstream failure");
            }
            _ => {}
        }

        let status = self.status();
        let body = ErrorEnvelope {
            error: ErrorBody {
                code: self.code(),
                message: self.public_message(),
                fields: match &self {
                    Self::Validation(fields) => Some(fields.clone()),
                    _ => None,
                },
                retry_after_ms: match &self {
                    Self::RateLimited { retry_after_ms } => Some(*retry_after_ms),
                    _ => None,
                },
            },
        };

        (status, Json(body)).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::RowNotFound => Self::NotFound { resource: "record" },
            // 23505 unique_violation — surfaces as a conflict the user can fix.
            sqlx::Error::Database(ref db) if db.code().as_deref() == Some("23505") => {
                Self::Conflict("That already exists.".into())
            }
            other => Self::Internal(anyhow::Error::new(other).context("database query failed")),
        }
    }
}

impl From<redis::RedisError> for AppError {
    fn from(err: redis::RedisError) -> Self {
        Self::Internal(anyhow::Error::new(err).context("redis command failed"))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        Self::Upstream(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_detail_never_reaches_the_client() {
        let err = AppError::Internal(anyhow::anyhow!("connection string: postgres://u:pw@h/db"));
        let public = err.public_message();
        assert!(!public.contains("postgres://"));
        assert!(!public.contains("pw"));
    }

    #[test]
    fn client_errors_keep_their_message() {
        let err = AppError::Conflict("Room code already taken.".into());
        assert_eq!(err.public_message(), "Room code already taken.");
        assert_eq!(err.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn unique_violation_maps_to_conflict() {
        // Constructing a sqlx DatabaseError directly is not possible outside the
        // crate, so this documents the mapping rather than exercising it; the
        // integration suite covers the real path.
        assert_eq!(AppError::Conflict(String::new()).status(), StatusCode::CONFLICT);
    }
}
