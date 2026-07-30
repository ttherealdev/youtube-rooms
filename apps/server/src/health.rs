//! Health and metrics endpoints.
//!
//! Liveness and readiness are deliberately separate. A node that is draining is
//! *alive* (do not kill it — it is flushing state) but *not ready* (stop
//! sending it traffic). Collapsing the two into one endpoint is what makes
//! rolling deploys drop connections.

use crate::state::AppState;
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Serialize;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// Flipped by the shutdown handler before the drain begins.
pub static DRAINING: AtomicBool = AtomicBool::new(false);

pub fn begin_drain() {
    DRAINING.store(true, Ordering::SeqCst);
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/live", get(live))
        .route("/ready", get(ready))
}

#[derive(Serialize)]
struct Liveness {
    status: &'static str,
    version: &'static str,
}

/// Is the process running? Nothing more — this must not touch a dependency, or
/// a database blip triggers a restart loop that makes the outage worse.
async fn live() -> Json<Liveness> {
    Json(Liveness {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Readiness {
    status: &'static str,
    database: bool,
    redis: bool,
    draining: bool,
    active_rooms: usize,
    owned_rooms: usize,
    connections: i64,
}

/// Should this node receive traffic?
async fn ready(State(state): State<AppState>) -> Response {
    let draining = DRAINING.load(Ordering::SeqCst);

    let database = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
        .is_ok();

    let redis = {
        let mut connection = state.redis.clone();
        redis::cmd("PING")
            .query_async::<String>(&mut connection)
            .await
            .is_ok()
    };

    let healthy = database && redis && !draining;

    let body = Readiness {
        status: if healthy { "ready" } else { "unavailable" },
        database,
        redis,
        draining,
        active_rooms: state.hub.active_room_count(),
        owned_rooms: state.hub.owned_room_count(),
        connections: state.metrics.ws_connections.load(Ordering::Relaxed),
    };

    let status = if healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (status, Json(body)).into_response()
}

/// Prometheus exposition. Kept off the public router by the reverse proxy.
pub async fn metrics(State(state): State<AppState>) -> Response {
    // Refresh gauges that are derived rather than incrementally maintained.
    state
        .metrics
        .rooms_active
        .store(state.hub.active_room_count() as i64, Ordering::Relaxed);
    state
        .metrics
        .rooms_owned
        .store(state.hub.owned_room_count() as i64, Ordering::Relaxed);

    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
        state.metrics.render_prometheus(),
    )
        .into_response()
}

/// Wait for either SIGTERM or Ctrl-C, then start the drain.
///
/// The order matters: flip readiness to 503 first so the proxy removes us from
/// the pool, give it a beat to notice, and only then release leases and close
/// sockets. Doing it the other way round drops live rooms (ADR 0010).
pub async fn shutdown_signal(hub: Arc<crate::realtime::hub::Hub>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(error) => {
                tracing::error!(?error, "could not install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => tracing::info!("received SIGINT"),
        () = terminate => tracing::info!("received SIGTERM"),
    }

    begin_drain();
    tracing::info!("draining: readiness is now failing");

    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    hub.drain().await;
    tracing::info!("drain complete; shutting down");
}
