//! YouTube metadata and search.
//!
//! All calls are **server-side with our own API key**. The browser never talks
//! to the Data API, which keeps the key out of the bundle, lets us cache
//! aggressively in Redis, and means a room full of people adding the same video
//! costs one upstream call rather than forty.
//!
//! Nothing here touches a user's YouTube account — see ADR 0007 on why we do
//! not request `youtube.readonly`.

use crate::{
    cache::{self, Redis},
    config::YouTubeConfig,
    error::AppError,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetadata {
    pub video_id: String,
    pub title: String,
    pub channel_title: String,
    pub duration_seconds: i32,
    pub thumbnail_url: String,
    pub view_count: Option<i64>,
    pub published_at: Option<i64>,
    /// False when the video cannot be played in an embedded player. We surface
    /// this before it is queued rather than letting the room hit a black frame.
    pub embeddable: bool,
}

impl VideoMetadata {
    /// A usable record for when the Data API is not configured.
    ///
    /// The room still works without an API key — the queue just shows the video
    /// id until someone plays it. Degrading is much better than refusing.
    pub fn placeholder(video_id: &str) -> Self {
        Self {
            video_id: video_id.to_owned(),
            title: format!("Video {video_id}"),
            channel_title: String::new(),
            duration_seconds: 0,
            thumbnail_url: format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"),
            view_count: None,
            published_at: None,
            embeddable: true,
        }
    }
}

pub struct YouTube {
    config: YouTubeConfig,
    http: reqwest::Client,
}

impl YouTube {
    pub fn new(config: YouTubeConfig, http: reqwest::Client) -> Self {
        Self { config, http }
    }

    pub fn is_configured(&self) -> bool {
        self.config.api_key.is_some()
    }

    /// Metadata for one video, cached in Redis.
    pub async fn video(&self, redis: &mut Redis, video_id: &str) -> VideoMetadata {
        let key = cache::keys::video_metadata(video_id);

        if let Ok(Some(cached)) = cache::get_json::<VideoMetadata>(redis, &key).await {
            return cached;
        }

        let Some(api_key) = &self.config.api_key else {
            return VideoMetadata::placeholder(video_id);
        };

        match self.fetch_video(api_key, video_id).await {
            Ok(Some(metadata)) => {
                let _ =
                    cache::set_json(redis, &key, &metadata, self.config.metadata_cache_ttl).await;
                metadata
            }
            Ok(None) => VideoMetadata::placeholder(video_id),
            Err(error) => {
                // Never fail a queue-add because YouTube is having a moment.
                tracing::warn!(?error, %video_id, "video metadata lookup failed");
                VideoMetadata::placeholder(video_id)
            }
        }
    }

    async fn fetch_video(
        &self,
        api_key: &str,
        video_id: &str,
    ) -> Result<Option<VideoMetadata>, AppError> {
        let url = format!(
            "https://www.googleapis.com/youtube/v3/videos\
             ?part=snippet,contentDetails,statistics,status&id={id}&key={key}",
            id = urlencoding::encode(video_id),
            key = urlencoding::encode(api_key),
        );

        let response: VideoListResponse = self.http.get(url).send().await?.json().await?;

        Ok(response.items.into_iter().next().map(|item| VideoMetadata {
            video_id: item.id,
            title: item.snippet.title,
            channel_title: item.snippet.channel_title,
            duration_seconds: parse_iso8601_duration(&item.content_details.duration),
            thumbnail_url: item.snippet.thumbnails.best(),
            view_count: item
                .statistics
                .and_then(|s| s.view_count)
                .and_then(|v| v.parse().ok()),
            published_at: chrono::DateTime::parse_from_rfc3339(&item.snippet.published_at)
                .ok()
                .map(|dt| dt.timestamp_millis()),
            embeddable: item.status.map(|s| s.embeddable).unwrap_or(true),
        }))
    }

    /// Search, restricted to embeddable videos so results cannot be queued into
    /// a room that then refuses to play them.
    pub async fn search(&self, query: &str, limit: u8) -> Result<Vec<VideoMetadata>, AppError> {
        let Some(api_key) = &self.config.api_key else {
            return Err(AppError::BadRequest(
                "Search is unavailable — paste a YouTube link instead.".into(),
            ));
        };

        let url = format!(
            "https://www.googleapis.com/youtube/v3/search\
             ?part=snippet&type=video&videoEmbeddable=true&maxResults={limit}\
             &q={q}&key={key}",
            limit = limit.clamp(1, 25),
            q = urlencoding::encode(query),
            key = urlencoding::encode(api_key),
        );

        let response: SearchResponse = self.http.get(url).send().await?.json().await?;

        Ok(response
            .items
            .into_iter()
            .filter_map(|item| {
                let video_id = item.id.video_id?;
                Some(VideoMetadata {
                    video_id,
                    title: item.snippet.title,
                    channel_title: item.snippet.channel_title,
                    // The search endpoint does not return durations; the queue
                    // fills this in from the cached video lookup on add.
                    duration_seconds: 0,
                    thumbnail_url: item.snippet.thumbnails.best(),
                    view_count: None,
                    published_at: chrono::DateTime::parse_from_rfc3339(&item.snippet.published_at)
                        .ok()
                        .map(|dt| dt.timestamp_millis()),
                    embeddable: true,
                })
            })
            .collect())
    }
}

// --- Data API response shapes ----------------------------------------------

#[derive(Debug, Deserialize)]
struct VideoListResponse {
    #[serde(default)]
    items: Vec<VideoItem>,
}

#[derive(Debug, Deserialize)]
struct VideoItem {
    id: String,
    snippet: Snippet,
    #[serde(rename = "contentDetails")]
    content_details: ContentDetails,
    statistics: Option<Statistics>,
    status: Option<Status>,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    items: Vec<SearchItem>,
}

#[derive(Debug, Deserialize)]
struct SearchItem {
    id: SearchId,
    snippet: Snippet,
}

#[derive(Debug, Deserialize)]
struct SearchId {
    #[serde(rename = "videoId")]
    video_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Snippet {
    title: String,
    #[serde(rename = "channelTitle", default)]
    channel_title: String,
    #[serde(rename = "publishedAt", default)]
    published_at: String,
    #[serde(default)]
    thumbnails: Thumbnails,
}

#[derive(Debug, Default, Deserialize)]
struct Thumbnails {
    maxres: Option<Thumbnail>,
    standard: Option<Thumbnail>,
    high: Option<Thumbnail>,
    medium: Option<Thumbnail>,
    default: Option<Thumbnail>,
}

impl Thumbnails {
    /// Highest resolution actually present. YouTube omits `maxres` for many
    /// videos, so this walks down rather than assuming.
    fn best(&self) -> String {
        [
            &self.maxres,
            &self.standard,
            &self.high,
            &self.medium,
            &self.default,
        ]
        .into_iter()
        .flatten()
        .map(|t| t.url.clone())
        .next()
        .unwrap_or_default()
    }
}

#[derive(Debug, Deserialize)]
struct Thumbnail {
    url: String,
}

#[derive(Debug, Deserialize)]
struct ContentDetails {
    #[serde(default)]
    duration: String,
}

#[derive(Debug, Deserialize)]
struct Statistics {
    #[serde(rename = "viewCount")]
    view_count: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Status {
    #[serde(default = "default_embeddable")]
    embeddable: bool,
}

const fn default_embeddable() -> bool {
    true
}

/// Parse the ISO 8601 durations the Data API returns (`PT4M13S`, `P1DT2H`).
///
/// Hand-rolled rather than pulling in a duration crate: the subset YouTube
/// emits is small and closed, and this way the parser is testable against the
/// exact shapes we see.
fn parse_iso8601_duration(input: &str) -> i32 {
    let Some(rest) = input.strip_prefix('P') else {
        return 0;
    };

    let (date_part, time_part) = match rest.split_once('T') {
        Some((date, time)) => (date, time),
        None => (rest, ""),
    };

    let mut total: i64 = 0;
    let mut number = String::new();

    for ch in date_part.chars() {
        if ch.is_ascii_digit() {
            number.push(ch);
        } else {
            let value: i64 = number.parse().unwrap_or(0);
            number.clear();
            match ch {
                'D' => total += value * 86_400,
                'W' => total += value * 604_800,
                _ => {}
            }
        }
    }

    number.clear();
    for ch in time_part.chars() {
        if ch.is_ascii_digit() {
            number.push(ch);
        } else {
            let value: i64 = number.parse().unwrap_or(0);
            number.clear();
            match ch {
                'H' => total += value * 3_600,
                'M' => total += value * 60,
                'S' => total += value,
                _ => {}
            }
        }
    }

    total.clamp(0, i64::from(i32::MAX)) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_duration_shapes_youtube_emits() {
        assert_eq!(parse_iso8601_duration("PT4M13S"), 253);
        assert_eq!(parse_iso8601_duration("PT1H2M3S"), 3_723);
        assert_eq!(parse_iso8601_duration("PT45S"), 45);
        assert_eq!(parse_iso8601_duration("PT2H"), 7_200);
        assert_eq!(parse_iso8601_duration("P1DT2H"), 93_600);
    }

    #[test]
    fn malformed_durations_are_zero_not_a_panic() {
        assert_eq!(parse_iso8601_duration(""), 0);
        assert_eq!(parse_iso8601_duration("garbage"), 0);
        assert_eq!(parse_iso8601_duration("P"), 0);
        assert_eq!(parse_iso8601_duration("PT"), 0);
    }

    #[test]
    fn live_streams_report_zero_rather_than_failing() {
        // The API returns P0D for an in-progress live stream.
        assert_eq!(parse_iso8601_duration("P0D"), 0);
    }

    #[test]
    fn thumbnail_selection_walks_down_from_the_best_available() {
        let only_medium = Thumbnails {
            medium: Some(Thumbnail { url: "medium".into() }),
            ..Default::default()
        };
        assert_eq!(only_medium.best(), "medium");

        let with_maxres = Thumbnails {
            maxres: Some(Thumbnail { url: "maxres".into() }),
            medium: Some(Thumbnail { url: "medium".into() }),
            ..Default::default()
        };
        assert_eq!(with_maxres.best(), "maxres");

        assert_eq!(Thumbnails::default().best(), "");
    }

    #[test]
    fn placeholder_is_usable_without_an_api_key() {
        let placeholder = VideoMetadata::placeholder("dQw4w9WgXcQ");
        assert_eq!(placeholder.video_id, "dQw4w9WgXcQ");
        assert!(placeholder.thumbnail_url.contains("dQw4w9WgXcQ"));
        assert!(placeholder.embeddable, "must not block queueing");
    }
}
