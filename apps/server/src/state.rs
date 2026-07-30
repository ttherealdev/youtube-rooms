//! Shared application state.
//!
//! One `Arc` behind a `Deref`, so handlers write `state.db` rather than
//! `state.0.db`, and cloning into every request stays cheap.

use crate::{
    auth::tokens::TokenKeys, cache::Redis, config::Config, metrics::Metrics, realtime::hub::Hub,
};
use sqlx::PgPool;
use std::{ops::Deref, sync::Arc};

pub struct Inner {
    pub config: Arc<Config>,
    pub db: PgPool,
    pub redis: Redis,
    pub keys: TokenKeys,
    pub metrics: Metrics,
    /// Shared outbound client. Building one per request would leak connection
    /// pools and defeat keep-alive to Google and the YouTube API.
    pub http: reqwest::Client,
    pub hub: Arc<Hub>,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl AppState {
    pub fn new(inner: Inner) -> Self {
        Self(Arc::new(inner))
    }
}

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
