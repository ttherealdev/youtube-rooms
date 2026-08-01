//! Router assembly and the middleware stack.

use crate::{
    auth::{self, CurrentUser},
    db,
    error::{AppError, AppResult},
    health,
    realtime::ws,
    rooms,
    state::AppState,
    util,
    youtube::YouTube,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderName, HeaderValue, Method, header},
    routing::get,
};
use serde::Deserialize;
use std::{sync::atomic::Ordering, time::Duration};
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    cors::CorsLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

const REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

pub fn build(state: AppState) -> Router {
    let api = Router::new()
        .nest("/auth", auth::routes::router())
        .nest("/rooms", rooms::routes::router())
        .nest("/me", me_router())
        .route("/videos/search", get(search_videos))
        .route("/videos/resolve", get(resolve_video))
        .route("/config", get(client_config));

    // Health and metrics sit outside the throttle: a probe must never be
    // rate-limited, or a busy node looks dead and gets restarted.
    let throttled = Router::new()
        .nest("/api", api)
        .route("/ws/rooms/{room_id}", get(ws::handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            throttle_by_ip,
        ));

    let router = Router::new()
        .merge(throttled)
        .nest("/health", health::router())
        .route("/metrics", get(health::metrics))
        .with_state(state.clone());

    apply_layers(router, &state)
}

/// The caller's real IP address.
///
/// Behind a reverse proxy the TCP peer is the *proxy*, so rate limiting on it
/// puts every user in the world into one shared bucket — the whole site starts
/// returning 429 under trivial load. Deployments therefore have to read the
/// forwarded headers instead.
///
/// This is gated on `TRUST_PROXY_HEADERS` and defaults to **off**, because a
/// directly-reachable origin that believes `X-Forwarded-For` lets any client
/// forge an identity and bypass every per-IP limit. Turn it on only when the
/// origin cannot be reached except through your proxy.
pub fn client_ip(
    headers: &axum::http::HeaderMap,
    peer: std::net::SocketAddr,
    trust_proxy: bool,
) -> String {
    if !trust_proxy {
        return peer.ip().to_string();
    }

    // Cloudflare sets this and strips any client-supplied copy, so it is the
    // most trustworthy value when it is present.
    if let Some(value) = headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()) {
        let candidate = value.trim();
        if !candidate.is_empty() {
            return candidate.to_owned();
        }
    }

    // Otherwise the leftmost entry of X-Forwarded-For is the original client;
    // everything after it is the proxy chain that handled the request.
    if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        && let Some(first) = forwarded.split(',').next()
    {
        let candidate = first.trim();
        if !candidate.is_empty() {
            return candidate.to_owned();
        }
    }

    peer.ip().to_string()
}

#[cfg(test)]
mod client_ip_tests {
    use super::client_ip;
    use axum::http::{HeaderMap, HeaderValue};

    fn peer() -> std::net::SocketAddr {
        "10.0.0.7:54321".parse().expect("valid addr")
    }

    #[test]
    fn untrusted_deployments_ignore_forwarded_headers() {
        // Without a proxy in front, believing these would let any client claim
        // a fresh identity and bypass every per-IP limit.
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("1.2.3.4"));
        headers.insert("cf-connecting-ip", HeaderValue::from_static("5.6.7.8"));

        assert_eq!(client_ip(&headers, peer(), false), "10.0.0.7");
    }

    #[test]
    fn cloudflare_header_wins_when_trusted() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", HeaderValue::from_static("203.0.113.9"));
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.9, 172.70.1.1"),
        );

        assert_eq!(client_ip(&headers, peer(), true), "203.0.113.9");
    }

    #[test]
    fn falls_back_to_the_leftmost_forwarded_entry() {
        // Everything after the first hop is the proxy chain, not the client.
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("198.51.100.4, 172.70.1.1, 10.0.0.2"),
        );

        assert_eq!(client_ip(&headers, peer(), true), "198.51.100.4");
    }

    #[test]
    fn falls_back_to_the_socket_when_headers_are_absent_or_blank() {
        assert_eq!(client_ip(&HeaderMap::new(), peer(), true), "10.0.0.7");

        let mut blank = HeaderMap::new();
        blank.insert("x-forwarded-for", HeaderValue::from_static("   "));
        assert_eq!(client_ip(&blank, peer(), true), "10.0.0.7");
    }

    #[test]
    fn distinct_clients_behind_one_proxy_get_distinct_buckets() {
        // The property that matters: without this, every user of the site
        // shares a single rate-limit bucket and the whole thing 429s.
        let mut a = HeaderMap::new();
        a.insert("cf-connecting-ip", HeaderValue::from_static("203.0.113.1"));
        let mut b = HeaderMap::new();
        b.insert("cf-connecting-ip", HeaderValue::from_static("203.0.113.2"));

        assert_ne!(client_ip(&a, peer(), true), client_ip(&b, peer(), true));
    }
}

/// Coarse per-IP ceiling in front of everything.
///
/// The per-action limits inside handlers are the meaningful ones; this exists
/// so an unauthenticated flood cannot reach them in the first place.
async fn throttle_by_ip(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, AppError> {
    state.metrics.http_requests.fetch_add(1, Ordering::Relaxed);

    let subject = client_ip(request.headers(), peer, state.config.trust_proxy_headers);

    let mut redis = state.redis.clone();
    let decision = crate::ratelimit::check_per_minute(
        &mut redis,
        "http",
        &subject,
        state.config.limits.http_per_minute,
    )
    .await;

    if !decision.allowed {
        state.metrics.rate_limited.fetch_add(1, Ordering::Relaxed);
        return Err(AppError::RateLimited {
            retry_after_ms: decision.retry_after_ms,
        });
    }

    Ok(next.run(request).await)
}

/// Security headers applied to every response.
///
/// The CSP stays strict where strictness costs nothing, and is explicit about
/// the two places it cannot be: a room plays arbitrary URLs, so `media-src` and
/// `img-src` have to admit any https origin. Pinning those to an allowlist
/// would mean the product only works for hosts we happened to think of, which
/// is the opposite of what a room is for. Everything that executes code —
/// `script-src`, `frame-src`, `object-src` — stays on a named list.
pub fn security_headers(state: &AppState) -> Vec<(HeaderName, HeaderValue)> {
    let csp = "default-src 'self'; \
               frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://player.kick.com; \
               img-src 'self' data: https:; \
               media-src 'self' blob: https:; \
               script-src 'self' https://www.youtube.com https://s.ytimg.com https://player.twitch.tv; \
               style-src 'self' 'unsafe-inline'; \
               connect-src 'self' ws: wss:; \
               font-src 'self' data:; \
               object-src 'none'; \
               base-uri 'self'; \
               form-action 'self'; \
               frame-ancestors 'none'";

    let mut headers = vec![
        (
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
        (
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ),
        (
            header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ),
        (
            HeaderName::from_static("permissions-policy"),
            // Microphone is required for voice; everything else is denied.
            HeaderValue::from_static("microphone=(self), camera=(), geolocation=(), payment=()"),
        ),
        (
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_str(csp).unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'")),
        ),
    ];

    // HSTS only in production: sending it from a local http server would pin
    // the developer's browser to https on localhost.
    if state.config.environment.is_production() {
        headers.push((
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        ));
    }

    headers
}

/// CORS for the SPA origin only, with credentials so the refresh cookie flows.
pub fn cors(state: &AppState) -> CorsLayer {
    let origins: Vec<HeaderValue> = state
        .config
        .allowed_origins()
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, REQUEST_ID])
        .allow_credentials(true)
        .max_age(Duration::from_secs(3600))
}

/// The full outer stack, applied in `main` where the concrete types line up.
pub fn apply_layers(router: Router, state: &AppState) -> Router {
    let mut router = router
        .layer(TraceLayer::new_for_http())
        .layer(CompressionLayer::new())
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(cors(state))
        .layer(PropagateRequestIdLayer::new(REQUEST_ID))
        .layer(SetRequestIdLayer::new(REQUEST_ID, MakeRequestUuid))
        .layer(CatchPanicLayer::new());

    for (name, value) in security_headers(state) {
        router = router.layer(SetResponseHeaderLayer::if_not_present(name, value));
    }

    router
}

/// What this deployment can actually do.
///
/// The frontend needs to know whether to render a Google button or a search
/// box at all. Feature-detecting by calling an endpoint and handling the error
/// makes the first paint wrong; asking once is honest and cacheable.
async fn client_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let youtube = YouTube::new(state.config.youtube.clone(), state.http.clone());

    Json(serde_json::json!({
        "googleSignIn": state.config.google.is_some(),
        "videoSearch": youtube.is_configured(),
        "voiceMaxPeers": state.config.voice.mesh_max_peers,
        "maxRoomParticipants": 100,
        "reactions": crate::realtime::session::ALLOWED_REACTIONS,
    }))
}

// ---------------------------------------------------------------------------
// Current user
// ---------------------------------------------------------------------------

fn me_router() -> Router<AppState> {
    Router::new()
        .route("/history", get(watch_history))
        .route("/continue", get(continue_watching))
        .route("/progress", axum::routing::post(record_progress))
        .route("/bookmarks", get(list_bookmarks).post(add_bookmark))
        .route("/bookmarks/{id}", axum::routing::delete(delete_bookmark))
        .route("/favorites/{room_id}", axum::routing::put(add_favorite))
        .route("/favorites/{room_id}", axum::routing::delete(remove_favorite))
        .route("/stats", get(user_stats))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressRequest {
    video_id: String,
    title: String,
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    room_id: Option<uuid::Uuid>,
    position_seconds: f64,
    #[serde(default)]
    duration_seconds: i32,
}

/// Record how far the caller got in a video.
///
/// Client-reported rather than derived from the room timeline, because what
/// matters for "continue watching" is what *this person* saw — someone who
/// joined a room halfway through has not watched the first half.
async fn record_progress(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Json(body): Json<ProgressRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let video_id = util::parse_video_id(&body.video_id)
        .ok_or_else(|| AppError::field("videoId", "Not a YouTube video."))?;

    if !body.position_seconds.is_finite() || body.position_seconds < 0.0 {
        return Err(AppError::field("positionSeconds", "Invalid position."));
    }

    db::history::record_watch(
        &state.db,
        claims.sub,
        db::history::WatchProgress {
            room_id: body.room_id,
            video_id: &video_id,
            title: body.title.trim(),
            thumbnail_url: &body.thumbnail_url,
            position_seconds: body.position_seconds,
            duration_seconds: body.duration_seconds.max(0),
        },
    )
    .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_bookmark(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    axum::extract::Path(id): axum::extract::Path<uuid::Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let removed = db::history::remove_bookmark(&state.db, claims.sub, id).await?;
    if !removed {
        return Err(AppError::not_found("bookmark"));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn add_favorite(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    axum::extract::Path(room_id): axum::extract::Path<uuid::Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    db::history::set_favorite(&state.db, claims.sub, room_id, true).await?;
    Ok(Json(serde_json::json!({ "favorite": true })))
}

async fn remove_favorite(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    axum::extract::Path(room_id): axum::extract::Path<uuid::Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    db::history::set_favorite(&state.db, claims.sub, room_id, false).await?;
    Ok(Json(serde_json::json!({ "favorite": false })))
}

async fn watch_history(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let entries = db::history::recent_watches(&state.db, claims.sub, 50).await?;
    Ok(Json(entries.into_iter().map(watch_entry_json).collect()))
}

async fn continue_watching(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let entries = db::history::continue_watching(&state.db, claims.sub, 12).await?;
    Ok(Json(entries.into_iter().map(watch_entry_json).collect()))
}

fn watch_entry_json(entry: db::history::WatchHistoryEntry) -> serde_json::Value {
    serde_json::json!({
        "videoId": entry.video_id,
        "title": entry.title,
        "thumbnailUrl": entry.thumbnail_url,
        "roomId": entry.room_id,
        "roomName": entry.room_name,
        "positionSeconds": entry.position_seconds,
        "durationSeconds": entry.duration_seconds,
        "watchedAt": entry.watched_at.timestamp_millis(),
    })
}

async fn list_bookmarks(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let bookmarks = db::history::list_bookmarks(&state.db, claims.sub, 100).await?;
    Ok(Json(
        bookmarks
            .into_iter()
            .map(|b| {
                serde_json::json!({
                    "id": b.id,
                    "videoId": b.video_id,
                    "title": b.title,
                    "thumbnailUrl": b.thumbnail_url,
                    "positionSeconds": b.position_seconds,
                    "note": b.note,
                    "createdAt": b.created_at.timestamp_millis(),
                })
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddBookmarkRequest {
    video_id: String,
    title: String,
    #[serde(default)]
    thumbnail_url: String,
    #[serde(default)]
    position_seconds: Option<f64>,
    #[serde(default)]
    note: Option<String>,
}

async fn add_bookmark(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Json(body): Json<AddBookmarkRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let video_id = util::parse_video_id(&body.video_id)
        .ok_or_else(|| AppError::field("videoId", "Not a YouTube video."))?;

    let note = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(280).collect::<String>());

    let bookmark = db::history::add_bookmark(
        &state.db,
        claims.sub,
        &video_id,
        body.title.trim(),
        &body.thumbnail_url,
        body.position_seconds.filter(|p| p.is_finite() && *p >= 0.0),
        note.as_deref(),
    )
    .await?;

    Ok(Json(serde_json::json!({ "id": bookmark.id })))
}

async fn user_stats(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
) -> AppResult<Json<db::history::UserStats>> {
    Ok(Json(db::history::user_stats(&state.db, claims.sub).await?))
}

// ---------------------------------------------------------------------------
// Video lookup
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<u8>,
}

/// Search proxied through our own key, never the browser's.
async fn search_videos(
    State(state): State<AppState>,
    CurrentUser(claims): CurrentUser,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<Vec<crate::youtube::VideoMetadata>>> {
    let term = query.q.trim();
    if term.is_empty() {
        return Ok(Json(Vec::new()));
    }

    // Quota on the Data API is finite and shared; search is the expensive call.
    let mut redis = state.redis.clone();
    let decision =
        crate::ratelimit::check_per_minute(&mut redis, "search", &claims.sub.to_string(), 20).await;

    if !decision.allowed {
        state.metrics.rate_limited.fetch_add(1, Ordering::Relaxed);
        return Err(AppError::RateLimited {
            retry_after_ms: decision.retry_after_ms,
        });
    }

    let youtube = YouTube::new(state.config.youtube.clone(), state.http.clone());
    Ok(Json(youtube.search(term, query.limit.unwrap_or(12)).await?))
}

#[derive(Debug, Deserialize)]
struct ResolveQuery {
    url: String,
}

/// Turn a pasted URL into playable metadata, so the client can show a preview
/// before committing it to the queue.
async fn resolve_video(
    State(state): State<AppState>,
    CurrentUser(_): CurrentUser,
    Query(query): Query<ResolveQuery>,
) -> AppResult<Json<crate::youtube::VideoMetadata>> {
    let video_id = util::parse_video_id(&query.url)
        .ok_or_else(|| AppError::field("url", "That is not a YouTube link."))?;

    let youtube = YouTube::new(state.config.youtube.clone(), state.http.clone());
    let mut redis = state.redis.clone();
    Ok(Json(youtube.video(&mut redis, &video_id).await))
}
