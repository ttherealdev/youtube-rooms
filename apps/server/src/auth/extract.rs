//! Request extractors for authenticated endpoints.
//!
//! `CurrentUser` rejects; `MaybeUser` degrades. Handlers state which they need
//! in their signature, so an endpoint cannot accidentally be left open by
//! forgetting a check inside the body.

use crate::{auth::tokens::AccessClaims, error::AppError, state::AppState};
use axum::{
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts},
};

/// An authenticated caller. Extraction fails with 401 when absent or invalid.
#[derive(Debug, Clone)]
pub struct CurrentUser(pub AccessClaims);

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let claims = claims_from_parts(parts, state).ok_or(AppError::Unauthenticated)?;
        Ok(Self(claims))
    }
}

/// An optionally authenticated caller, for endpoints that behave differently
/// when signed in — the public directory, for instance, marks favourites.
#[derive(Debug, Clone)]
pub struct MaybeUser(pub Option<AccessClaims>);

impl FromRequestParts<AppState> for MaybeUser {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(claims_from_parts(parts, state)))
    }
}

/// Bearer tokens only.
///
/// Deliberately **not** read from a cookie: an endpoint that accepts a cookie
/// as proof of identity is CSRF-vulnerable by construction. The refresh cookie
/// is the sole exception and is scoped to `/api/auth` with `SameSite=Lax`.
fn claims_from_parts(parts: &Parts, state: &AppState) -> Option<AccessClaims> {
    let header = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    let token = header.strip_prefix("Bearer ").or_else(|| header.strip_prefix("bearer "))?;

    match state.keys.verify_access_token(token.trim()) {
        Ok(claims) => Some(claims),
        Err(error) => {
            tracing::debug!(?error, "rejected access token");
            None
        }
    }
}
