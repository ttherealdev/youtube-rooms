//! playercn — the authoritative realtime service.
//!
//! Architecture: `docs/architecture.md`
//! Decisions:    `docs/adr/`

mod auth;
mod cache;
mod config;
mod db;
mod error;
mod health;
mod media;
mod metrics;
mod kick;
mod ratelimit;
mod realtime;
mod rooms;
mod routes;
mod state;
mod sync;
mod telemetry;
mod util;
mod youtube;

use anyhow::Context;
use auth::tokens::TokenKeys;
use config::Config;
use realtime::hub::Hub;
use state::{AppState, Inner};
use std::{net::SocketAddr, sync::Arc, time::Duration};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // The distroless runtime image has no shell and no curl, so the container
    // health check re-invokes this binary instead (see Dockerfile).
    if std::env::args().any(|arg| arg == "--health-check") {
        return run_health_probe().await;
    }

    // Must happen before anything opens a TLS connection. Several dependencies
    // link rustls, and without an explicit choice the process has no default
    // provider — which surfaces as a panic on the first outbound HTTPS request
    // rather than at startup. Ring is chosen over aws-lc-rs because it needs no
    // C toolchain, which keeps the distroless build simple (ADR 0012).
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("a rustls crypto provider was already installed"))?;

    let config = Arc::new(Config::from_env()?);
    telemetry::init(config.environment);

    tracing::info!(
        env = %config.environment,
        version = env!("CARGO_PKG_VERSION"),
        public_url = %config.public_url,
        web_origin = %config.web_origin,
        "starting playercn server"
    );

    // --- Dependencies ------------------------------------------------------
    let db = db::connect(&config.database).await?;
    db::migrate(&db).await?;

    let redis = cache::connect(&config.redis.url).await?;

    let keys = TokenKeys::from_config(&config.auth)
        .map_err(|e| anyhow::anyhow!("could not load JWT keys: {e}"))?;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("playercn/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("could not build HTTP client")?;

    if config.google.is_none() {
        tracing::warn!("GOOGLE_CLIENT_ID/SECRET unset — only guest sign-in is available");
    }
    if config.youtube.api_key.is_none() {
        tracing::warn!("YOUTUBE_API_KEY unset — search is disabled; links still work");
    }
    if config.kick.client_id.is_none() || config.kick.client_secret.is_none() {
        tracing::warn!("KICK_CLIENT_ID/SECRET unset — Kick channels queue without a title or artwork");
    }

    let hub = Arc::new(Hub::new(Arc::clone(&config), db.clone(), redis.clone()));

    let state = AppState::new(Inner {
        config: Arc::clone(&config),
        db: db.clone(),
        redis: redis.clone(),
        keys,
        metrics: metrics::Metrics::default(),
        http,
        hub: Arc::clone(&hub),
    });

    // --- Background tasks --------------------------------------------------
    tokio::spawn(realtime::hub::run_broadcast_relay(
        Arc::clone(&hub),
        config.redis.url.clone(),
    ));

    tokio::spawn(realtime::autoadvance::run(state.clone()));

    tokio::spawn(realtime::relay::run(
        state.clone(),
        config.redis.url.clone(),
    ));

    tokio::spawn(renew_leases(Arc::clone(&hub), config.realtime.room_lease_renew));
    tokio::spawn(housekeeping(db.clone()));

    // Closes rooms that have sat empty past the grace period.
    rooms::lifecycle::spawn_sweeper(state.clone());

    // --- Serve -------------------------------------------------------------
    let app = routes::build(state);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .with_context(|| format!("could not bind {}", config.bind_addr))?;

    tracing::info!(addr = %config.bind_addr, node = %hub.node_id, "listening");

    // `into_make_service_with_connect_info` so handlers can rate-limit by IP.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(health::shutdown_signal(Arc::clone(&hub)))
    .await
    .context("server error")?;

    tracing::info!("shutdown complete");
    Ok(())
}

/// Probe our own readiness endpoint and exit 0/1.
///
/// Deliberately plain TCP + HTTP/1.1 rather than `reqwest`: the probe runs
/// every 15 seconds for the life of the container, and it should not pay for a
/// TLS stack and a connection pool to talk to localhost.
async fn run_health_probe() -> anyhow::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let port = addr.rsplit(':').next().unwrap_or("8080");
    let target = format!("127.0.0.1:{port}");

    let probe = async {
        let mut stream = tokio::net::TcpStream::connect(&target).await?;
        stream
            .write_all(b"GET /health/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await?;

        let mut response = Vec::with_capacity(512);
        stream.read_to_end(&mut response).await?;
        Ok::<_, std::io::Error>(response)
    };

    match tokio::time::timeout(Duration::from_secs(3), probe).await {
        Ok(Ok(response)) if response.starts_with(b"HTTP/1.1 200") => Ok(()),
        Ok(Ok(_)) => {
            eprintln!("health check: service reported not ready");
            std::process::exit(1);
        }
        Ok(Err(error)) => {
            eprintln!("health check: {error}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("health check: timed out");
            std::process::exit(1);
        }
    }
}

/// Keep our claim on every owned room alive. Losing a lease mid-session is
/// survivable — the next intent re-claims or forwards — but it should be rare
/// and visible.
async fn renew_leases(hub: Arc<Hub>, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        ticker.tick().await;
        hub.renew_leases().await;
    }
}

/// Periodic cleanup. Hourly is frequent enough for data that ages in days.
async fn housekeeping(db: sqlx::PgPool) {
    let mut ticker = tokio::time::interval(Duration::from_secs(3600));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        ticker.tick().await;

        match db::users::purge_expired_tokens(&db).await {
            Ok(count) if count > 0 => tracing::info!(count, "purged expired refresh tokens"),
            Err(error) => tracing::warn!(?error, "token purge failed"),
            _ => {}
        }

        match db::users::purge_stale_guests(&db).await {
            Ok(count) if count > 0 => tracing::info!(count, "purged stale guest accounts"),
            Err(error) => tracing::warn!(?error, "guest purge failed"),
            _ => {}
        }
    }
}
