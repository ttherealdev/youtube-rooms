//! Kick channel metadata.
//!
//! Kick's embed is the only way to *play* a channel — it publishes no
//! JavaScript API, and its public API does not hand out playback URLs for
//! channels you do not own (`stream.url` comes back empty even for a channel
//! that is live). So this module exists for everything *around* the picture:
//! the title, the artwork, and whether the channel is broadcasting at all.
//!
//! That is worth more than it sounds. A queued Kick link used to show its slug
//! and a black rectangle; now it shows what it is and what it looks like. The
//! artwork matters twice over, because some viewers cannot reach Kick at all —
//! it is blocked in a number of countries — and for them the poster the server
//! fetched is the only thing they will ever see of the stream.
//!
//! Like the YouTube module, every call is server-side with our own credentials.
//! The browser never talks to Kick's API, the secret stays out of the bundle,
//! and Redis absorbs the repeat lookups.

use crate::{
    cache::{self, Redis},
    config::KickConfig,
};
use serde::{Deserialize, Serialize};

/// How long before a token's stated expiry to stop trusting it.
///
/// Covers the round trip plus any clock skew between us and Kick, so a token
/// is never presented in the moment it turns invalid.
const TOKEN_SLACK_SECS: u64 = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMetadata {
    pub slug: String,
    /// The stream title when live, falling back to the channel name.
    pub title: String,
    pub channel_title: String,
    pub thumbnail_url: String,
    pub is_live: bool,
    pub viewer_count: i64,
}

impl ChannelMetadata {
    /// A usable record for when Kick is not configured, or the lookup failed.
    ///
    /// The room still plays the channel without any of this — the queue just
    /// shows the slug. Degrading beats refusing, exactly as with YouTube.
    pub fn placeholder(slug: &str) -> Self {
        Self {
            slug: slug.to_owned(),
            title: slug.to_owned(),
            channel_title: String::new(),
            thumbnail_url: String::new(),
            is_live: false,
            viewer_count: 0,
        }
    }
}

pub struct Kick {
    config: KickConfig,
    http: reqwest::Client,
}

impl Kick {
    pub fn new(config: KickConfig, http: reqwest::Client) -> Self {
        Self { config, http }
    }

    pub fn is_configured(&self) -> bool {
        has_credentials(&self.config)
    }

    /// Look a channel up, answering with a placeholder rather than an error.
    ///
    /// Nothing here is worth failing a queue add over: a channel that cannot be
    /// described can still be watched, and refusing the link because our
    /// metadata call timed out would be the tail wagging the dog.
    pub async fn channel(&self, redis: &mut Redis, slug: &str) -> ChannelMetadata {
        let slug = slug.to_ascii_lowercase();
        if !self.is_configured() {
            return ChannelMetadata::placeholder(&slug);
        }

        let key = cache::keys::kick_channel(&slug);
        if let Ok(Some(hit)) = cache::get_json::<ChannelMetadata>(redis, &key).await {
            return hit;
        }

        let Some(metadata) = self.fetch_channel(redis, &slug).await else {
            return ChannelMetadata::placeholder(&slug);
        };

        // Short-lived on purpose: `is_live` and the viewer count are the whole
        // point of the record and both go stale in minutes.
        let _ = cache::set_json(redis, &key, &metadata, self.config.metadata_cache_ttl).await;
        metadata
    }

    async fn fetch_channel(&self, redis: &mut Redis, slug: &str) -> Option<ChannelMetadata> {
        let token = self.token(redis).await?;

        let url = format!(
            "https://api.kick.com/public/v1/channels?slug={slug}",
            slug = urlencoding::encode(slug),
        );

        let response = self
            .http
            .get(url)
            .bearer_auth(&token)
            .timeout(self.config.request_timeout)
            .send()
            .await
            .ok()?;

        if !response.status().is_success() {
            // A rejected token is worth clearing: the next lookup mints a fresh
            // one instead of replaying a credential Kick has stopped accepting.
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                let _: Result<(), _> =
                    redis::cmd("DEL").arg(cache::keys::kick_token()).query_async(redis).await;
            }
            tracing::warn!(status = %response.status(), slug, "kick channel lookup failed");
            return None;
        }

        let body: ChannelsResponse = response.json().await.ok()?;
        let channel = body.data.into_iter().next()?;
        let stream = channel.stream.unwrap_or_default();

        // Best artwork available, in descending order of how much it tells you
        // about what is on screen right now.
        let thumbnail = [
            stream.thumbnail.as_deref(),
            channel.category.as_ref().and_then(|c| c.thumbnail.as_deref()),
            channel.banner_picture.as_deref(),
        ]
        .into_iter()
        .flatten()
        .find(|url| !url.is_empty())
        .unwrap_or_default()
        .to_owned();

        let title = channel
            .stream_title
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| channel.slug.clone());

        Some(ChannelMetadata {
            channel_title: channel.slug.clone(),
            slug: channel.slug,
            title,
            thumbnail_url: thumbnail,
            is_live: stream.is_live,
            viewer_count: stream.viewer_count,
        })
    }

    /// An app access token, from Redis when one is still good.
    async fn token(&self, redis: &mut Redis) -> Option<String> {
        let key = cache::keys::kick_token();
        if let Ok(Some(cached)) = cache::get_json::<String>(redis, &key).await {
            return Some(cached);
        }

        let (id, secret) =
            (self.config.client_id.as_ref()?, self.config.client_secret.as_ref()?);

        let response = self
            .http
            .post("https://id.kick.com/oauth/token")
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", id.as_str()),
                ("client_secret", secret.as_str()),
            ])
            .timeout(self.config.request_timeout)
            .send()
            .await
            .ok()?;

        if !response.status().is_success() {
            // Deliberately without the body: a failed token exchange can echo
            // the credentials back, and this line goes to the log.
            tracing::warn!(status = %response.status(), "kick token request failed");
            return None;
        }

        let token: TokenResponse = response.json().await.ok()?;
        if token.access_token.is_empty() {
            return None;
        }

        let ttl = token.expires_in.saturating_sub(TOKEN_SLACK_SECS);
        if ttl > 0 {
            let _ = cache::set_json(
                redis,
                &key,
                &token.access_token,
                std::time::Duration::from_secs(ttl),
            )
            .await;
        }

        Some(token.access_token)
    }
}

/// Both halves, or nothing.
///
/// An id without a secret mints no token, and trying would spend a request to
/// Kick's identity service to discover that.
fn has_credentials(config: &KickConfig) -> bool {
    config.client_id.is_some() && config.client_secret.is_some()
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    expires_in: u64,
}

#[derive(Deserialize)]
struct ChannelsResponse {
    #[serde(default)]
    data: Vec<ChannelPayload>,
}

#[derive(Deserialize)]
struct ChannelPayload {
    #[serde(default)]
    slug: String,
    stream_title: Option<String>,
    banner_picture: Option<String>,
    stream: Option<StreamPayload>,
    category: Option<CategoryPayload>,
}

#[derive(Deserialize, Default)]
struct StreamPayload {
    #[serde(default)]
    is_live: bool,
    #[serde(default)]
    viewer_count: i64,
    thumbnail: Option<String>,
}

#[derive(Deserialize)]
struct CategoryPayload {
    thumbnail: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(configured: bool) -> KickConfig {
        KickConfig {
            client_id: configured.then(|| "id".to_owned()),
            client_secret: configured.then(|| "secret".to_owned()),
            metadata_cache_ttl: std::time::Duration::from_secs(300),
            request_timeout: std::time::Duration::from_secs(5),
        }
    }

    #[test]
    fn credentials_are_needed_in_full() {
        assert!(has_credentials(&config(true)));
        assert!(!has_credentials(&config(false)));

        // Half-configured is not configured.
        let mut half = config(true);
        half.client_secret = None;
        assert!(!has_credentials(&half));

        let mut other_half = config(true);
        other_half.client_id = None;
        assert!(!has_credentials(&other_half));
    }

    #[test]
    fn a_placeholder_still_names_the_channel() {
        // The queue row has to say *something*, and the slug is the only thing
        // known without a successful lookup.
        let placeholder = ChannelMetadata::placeholder("xqc");
        assert_eq!(placeholder.title, "xqc");
        assert_eq!(placeholder.slug, "xqc");
        assert!(!placeholder.is_live);
        assert!(placeholder.thumbnail_url.is_empty());
    }
}
