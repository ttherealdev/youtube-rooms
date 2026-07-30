//! Database access.
//!
//! Queries are written as SQL and mapped with `FromRow`. See ADR 0003 for why
//! we are not using the `query!` macros yet and how schema drift is caught
//! instead (an integration suite that runs against a real Postgres).
//!
//! ## On `sqlx::AssertSqlSafe`
//!
//! sqlx 0.9 refuses non-`'static` query strings unless they are explicitly
//! asserted safe. Every use of it in this module interpolates **only
//! compile-time constants** — shared column lists, and one `ORDER BY` clause
//! selected from three literals by an enum. No caller-supplied value is ever
//! formatted into SQL; user input reaches the database exclusively through
//! `.bind()`. Any new `AssertSqlSafe` call site must hold to that rule.

pub mod chat;
pub mod history;
pub mod queue;
pub mod rooms;
pub mod users;

use crate::config::DatabaseConfig;
use anyhow::Context;
use sqlx::postgres::{PgPool, PgPoolOptions};

pub async fn connect(config: &DatabaseConfig) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(config.max_connections)
        .min_connections(config.min_connections)
        .acquire_timeout(config.acquire_timeout)
        // Recycle periodically so a long-lived pool cannot accumulate sessions
        // pinned to a Postgres instance that has since been failed over.
        .max_lifetime(std::time::Duration::from_secs(30 * 60))
        .idle_timeout(std::time::Duration::from_secs(10 * 60))
        .test_before_acquire(true)
        .connect(&config.url)
        .await
        .context("could not connect to Postgres")?;

    Ok(pool)
}

/// Applied at boot. Forward-only: a rollback is a new migration.
pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .context("database migration failed")?;
    tracing::info!("database migrations applied");
    Ok(())
}
