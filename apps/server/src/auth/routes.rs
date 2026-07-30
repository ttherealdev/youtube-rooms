//! Authentication endpoints.

use crate::{
    auth::{
        CurrentUser,
        cookies::{self, OAUTH_STATE_COOKIE, REFRESH_COOKIE},
        google,
        tokens::{self, WsTicket},
    },
    cache, db,
    error::{AppError, AppResult},
    ratelimit,
    state::AppState,
    util,
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, Query, State},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use axum_extra::extract::cookie::CookieJar;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use uuid::Uuid;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/guest", post(guest_login))
        .route("/session", get(current_session).patch(update_profile))
        .route("/refresh", post(refresh))
        .route("/logout", post(logout))
        .route("/ws-ticket", post(ws_ticket))
        .route("/google/start", get(google_start))
        .route("/google/callback", get(google_callback))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    access_token: String,
    /// Seconds. The client refreshes at ~80% of this rather than on 401.
    expires_in: u64,
    user: db::users::UserSummary,
}

// ---------------------------------------------------------------------------
// Guest
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuestLoginRequest {
    display_name: String,
}

/// Guests are a first-class identity, not a fallback: most people arriving from
/// an invite link will never sign in, and the product has to be excellent for
/// them (ADR 0007).
async fn guest_login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    jar: CookieJar,
    Json(body): Json<GuestLoginRequest>,
) -> AppResult<Response> {
    // Limited by IP: this endpoint mints rows without any prior credential.
    let mut redis = state.redis.clone();
    let decision = ratelimit::check(
        &mut redis,
        "guest_signup",
        &peer.ip().to_string(),
        20,
        std::time::Duration::from_secs(3600),
    )
    .await;

    if !decision.allowed {
        return Err(AppError::RateLimited {
            retry_after_ms: decision.retry_after_ms,
        });
    }

    let display_name = util::normalize_display_name(&body.display_name);
    validate_display_name(&display_name)?;

    let user = db::users::create_guest(&state.db, &display_name).await?;
    issue_session(&state, jar, &user).await
}

fn validate_display_name(name: &str) -> Result<(), AppError> {
    let length = name.chars().count();
    if length < 2 {
        return Err(AppError::field("displayName", "Please use at least 2 characters."));
    }
    if length > 32 {
        return Err(AppError::field("displayName", "Please use at most 32 characters."));
    }
    // Control characters would let a name break the layout or impersonate UI.
    if name.chars().any(|c| c.is_control()) {
        return Err(AppError::field("displayName", "That name contains invalid characters."));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async fn current_session(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<db::users::UserSummary>> {
    let user = db::users::find_by_id(&state.db, claims.sub)
        .await?
        .ok_or(AppError::Unauthenticated)?;
    Ok(Json(db::users::UserSummary::from(&user)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProfileRequest {
    display_name: String,
}

/// Change the display name.
///
/// Guests need this most — they picked a name in a hurry to get through the
/// door and often want to fix it once they are inside.
async fn update_profile(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Json(body): Json<UpdateProfileRequest>,
) -> AppResult<Json<db::users::UserSummary>> {
    let display_name = util::normalize_display_name(&body.display_name);
    validate_display_name(&display_name)?;

    let user = db::users::rename(&state.db, claims.sub, &display_name).await?;
    Ok(Json(db::users::UserSummary::from(&user)))
}

/// Rotate the refresh token and mint a new access token.
///
/// Reuse detection: presenting an already-consumed token means either a replay
/// or a stolen cookie, and we cannot tell which — so the entire token family is
/// revoked and the user re-authenticates. This is the standard OAuth 2.1
/// recommendation for public clients.
async fn refresh(State(state): State<AppState>, jar: CookieJar) -> AppResult<Response> {
    let presented = jar
        .get(REFRESH_COOKIE)
        .map(|cookie| cookie.value().to_owned())
        .ok_or(AppError::Unauthenticated)?;

    let hash = util::sha256_hex(&presented);
    let record = db::users::find_refresh_token(&state.db, &hash)
        .await?
        .ok_or(AppError::Unauthenticated)?;

    if record.revoked_at.is_some() || record.expires_at < chrono::Utc::now() {
        return Err(AppError::Unauthenticated);
    }

    if record.consumed_at.is_some() {
        tracing::warn!(
            user = %record.user_id,
            family = %record.family_id,
            "refresh token reuse detected; revoking family"
        );
        db::users::revoke_family(&state.db, record.family_id).await?;
        db::history::audit(
            &state.db,
            Some(record.user_id),
            None,
            "auth.refresh_reuse_detected",
            serde_json::json!({ "family": record.family_id }),
        )
        .await;
        return Err(AppError::Unauthenticated);
    }

    if !db::users::consume_refresh_token(&state.db, record.id).await? {
        // Lost a race with a concurrent refresh; treat as reuse.
        return Err(AppError::Unauthenticated);
    }

    let user = db::users::find_by_id(&state.db, record.user_id)
        .await?
        .ok_or(AppError::Unauthenticated)?;

    issue_session_in_family(&state, jar, &user, record.family_id).await
}

async fn logout(State(state): State<AppState>, jar: CookieJar) -> AppResult<Response> {
    if let Some(cookie) = jar.get(REFRESH_COOKIE) {
        let hash = util::sha256_hex(cookie.value());
        if let Some(record) = db::users::find_refresh_token(&state.db, &hash).await? {
            // Sign out everywhere on this device lineage, not just this tab.
            db::users::revoke_family(&state.db, record.family_id).await?;
        }
    }

    let jar = jar.add(cookies::clear_refresh_cookie(&state.config.auth));
    Ok((jar, Json(serde_json::json!({ "ok": true }))).into_response())
}

async fn issue_session(
    state: &AppState,
    jar: CookieJar,
    user: &db::users::User,
) -> AppResult<Response> {
    issue_session_in_family(state, jar, user, Uuid::now_v7()).await
}

async fn issue_session_in_family(
    state: &AppState,
    jar: CookieJar,
    user: &db::users::User,
    family_id: Uuid,
) -> AppResult<Response> {
    let (access_token, claims) = state
        .keys
        .issue_access_token(user, state.config.auth.access_token_ttl)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to mint access token: {e}")))?;

    let refresh = tokens::generate_refresh_token();
    let expires_at = chrono::Utc::now()
        + chrono::Duration::from_std(state.config.auth.refresh_token_ttl)
            .unwrap_or_else(|_| chrono::Duration::days(30));

    db::users::insert_refresh_token(
        &state.db,
        user.id,
        &refresh.hash,
        family_id,
        expires_at,
        None,
    )
    .await?;

    let jar = jar.add(cookies::refresh_cookie(
        &state.config.auth,
        refresh.plaintext,
    ));

    let body = SessionResponse {
        access_token,
        expires_in: (claims.exp - claims.iat).max(0) as u64,
        user: db::users::UserSummary::from(user),
    };

    Ok((jar, Json(body)).into_response())
}

// ---------------------------------------------------------------------------
// WebSocket tickets
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsTicketRequest {
    room_id: Uuid,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsTicketResponse {
    ticket: String,
    expires_in: u64,
}

/// Mint a single-use ticket for opening a socket to one specific room.
async fn ws_ticket(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Json(body): Json<WsTicketRequest>,
) -> AppResult<Json<WsTicketResponse>> {
    // The room must exist before we hand out a credential naming it.
    db::rooms::find_by_id(&state.db, body.room_id)
        .await?
        .ok_or_else(|| AppError::not_found("room"))?;

    let issued = tokens::generate_ws_ticket(claims.sub, body.room_id);
    let mut redis = state.redis.clone();

    cache::set_json::<WsTicket>(
        &mut redis,
        &cache::keys::ws_ticket(&issued.hash),
        &issued.payload,
        state.config.auth.ws_ticket_ttl,
    )
    .await
    .map_err(AppError::Internal)?;

    Ok(Json(WsTicketResponse {
        ticket: issued.plaintext,
        expires_in: state.config.auth.ws_ticket_ttl.as_secs(),
    }))
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct StartQuery {
    #[serde(default)]
    return_to: Option<String>,
}

async fn google_start(
    State(state): State<AppState>,
    Query(query): Query<StartQuery>,
    jar: CookieJar,
) -> AppResult<Response> {
    let config = state
        .config
        .google
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("Google sign-in is not configured.".into()))?;

    let return_to = query.return_to.as_deref().unwrap_or("/");
    let request = google::begin(config, return_to);

    // Server-side half of the CSRF pair; the cookie is the other half.
    let mut redis = state.redis.clone();
    cache::set_json(
        &mut redis,
        &cache::keys::oauth_state(&request.state_hash),
        &request.pending,
        std::time::Duration::from_secs(600),
    )
    .await
    .map_err(AppError::Internal)?;

    let jar = jar.add(cookies::oauth_state_cookie(
        &state.config.auth,
        request.state.clone(),
    ));

    Ok((jar, Redirect::temporary(&request.url)).into_response())
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn google_callback(
    State(state): State<AppState>,
    Query(query): Query<CallbackQuery>,
    jar: CookieJar,
) -> AppResult<Response> {
    let config = state
        .config
        .google
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("Google sign-in is not configured.".into()))?;

    let jar = jar.add(cookies::clear_oauth_state_cookie(&state.config.auth));

    // The user declined at the consent screen — not an error worth a 500.
    if let Some(reason) = query.error {
        tracing::info!(%reason, "user cancelled Google sign-in");
        return Ok((
            jar,
            Redirect::temporary(&format!("{}/login?error=cancelled", state.config.web_origin)),
        )
            .into_response());
    }

    let (code, returned_state) = match (query.code, query.state) {
        (Some(code), Some(state_value)) => (code, state_value),
        _ => return Err(AppError::BadRequest("Malformed OAuth callback.".into())),
    };

    // Both halves must agree. The cookie proves the callback reached the same
    // browser that started the flow; the Redis entry proves we started it.
    let cookie_state = jar
        .get(OAUTH_STATE_COOKIE)
        .map(|c| c.value().to_owned())
        .ok_or_else(|| AppError::BadRequest("Sign-in session expired. Please try again.".into()))?;

    if cookie_state != returned_state {
        tracing::warn!("OAuth state mismatch between cookie and callback");
        return Err(AppError::BadRequest("Invalid sign-in state.".into()));
    }

    let mut redis = state.redis.clone();
    let pending: google::PendingAuth = cache::take_json(
        &mut redis,
        &cache::keys::oauth_state(&util::sha256_hex(&returned_state)),
    )
    .await
    .map_err(AppError::Internal)?
    .ok_or_else(|| AppError::BadRequest("Sign-in session expired. Please try again.".into()))?;

    let identity = google::exchange_code(&state.http, config, &code, &pending).await?;

    let display_name = google::display_name_for(&identity);

    // Store the address only when Google says it is verified. An unverified
    // address is an unproven claim, and our unique index on lower(email) would
    // let one squat on it and block the real owner.
    let email = identity
        .email
        .as_deref()
        .filter(|_| identity.email_verified);

    let user = db::users::upsert_google_user(
        &state.db,
        &identity.sub,
        email,
        &display_name,
        identity.picture.as_deref(),
    )
    .await?;

    let destination = google::sanitize_return_to(&pending.return_to, &state.config.web_origin);

    // The access token cannot be delivered in the redirect body, and putting it
    // in the URL would leak it into history and referrers. Instead the refresh
    // cookie is set here and the SPA immediately calls /refresh to obtain the
    // access token over a normal XHR.
    let response = issue_session(&state, jar, &user).await?;
    let (mut parts, _) = response.into_parts();
    parts.status = axum::http::StatusCode::SEE_OTHER;
    parts.headers.insert(
        axum::http::header::LOCATION,
        axum::http::HeaderValue::from_str(&destination)
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("/")),
    );

    Ok(Response::from_parts(parts, axum::body::Body::empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_are_bounded_and_printable() {
        assert!(validate_display_name("Anas Mohamed").is_ok());
        assert!(validate_display_name("AM").is_ok());
        assert!(validate_display_name("A").is_err());
        assert!(validate_display_name(&"x".repeat(33)).is_err());
        assert!(validate_display_name("bad\u{0000}name").is_err());
        assert!(validate_display_name("line\nbreak").is_err());
    }

    #[test]
    fn multibyte_names_are_counted_by_character_not_byte() {
        // 4 chars, 12 bytes — must not be rejected as too long, and a 2-char
        // CJK name must not be rejected as too short.
        assert!(validate_display_name("日本語名").is_ok());
        assert!(validate_display_name("日本").is_ok());
        assert!(validate_display_name(&"あ".repeat(33)).is_err());
    }
}
