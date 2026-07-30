//! Structured logging setup.
//!
//! JSON in production so a log aggregator can index it; human-readable in
//! development because nobody debugs by reading JSON.

use crate::config::Environment;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

pub fn init(environment: Environment) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        let default = if environment.is_production() {
            "info,tower_http=info,sqlx=warn"
        } else {
            "debug,hyper=info,sqlx=info,tower_http=debug"
        };
        EnvFilter::new(default)
    });

    let registry = tracing_subscriber::registry().with(filter);

    if environment.is_production() {
        registry
            .with(
                tracing_subscriber::fmt::layer()
                    .json()
                    .flatten_event(true)
                    .with_current_span(true)
                    .with_span_list(false)
                    .with_target(true),
            )
            .init();
    } else {
        registry
            .with(
                tracing_subscriber::fmt::layer()
                    .with_target(false)
                    .with_line_number(true)
                    .compact(),
            )
            .init();
    }
}
