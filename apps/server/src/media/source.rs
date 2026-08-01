//! What a room can play.
//!
//! Before playercn a queue row *was* a YouTube video id. Now a row names a
//! source: how to play it, and where. The kind is what the browser needs in
//! order to pick a playback strategy — an iframe embed, a bare media element,
//! or a streaming library — so it is decided once here, on the server, rather
//! than re-sniffed by every client.
//!
//! Classification is deliberately permissive. VLC's contract is "give me a URL
//! and I will try", and a source we cannot categorise is far more usefully
//! attempted as a plain media file than rejected outright.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// Played through the YouTube IFrame API. The only kind with a video id.
    Youtube,
    /// Handed straight to a `<video>`/`<audio>` element.
    File,
    /// HLS manifest, played via Media Source Extensions.
    Hls,
    /// MPEG-DASH manifest, played via Media Source Extensions.
    Dash,
}

impl SourceKind {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "youtube" => Some(Self::Youtube),
            "file" => Some(Self::File),
            "hls" => Some(Self::Hls),
            "dash" => Some(Self::Dash),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Youtube => "youtube",
            Self::File => "file",
            Self::Hls => "hls",
            Self::Dash => "dash",
        }
    }

    /// Live sources have no meaningful duration or seek range, so the room
    /// must not try to auto-advance off the end of one.
    pub fn may_be_live(self) -> bool {
        matches!(self, Self::Hls | Self::Dash)
    }
}

/// A resolved, playable source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSource {
    pub kind: SourceKind,
    /// Canonical URL. For YouTube this is the watch URL, kept so the row is
    /// self-describing even though playback goes through the video id.
    pub url: String,
    /// Set for, and only for, `SourceKind::Youtube`.
    pub video_id: Option<String>,
}

impl MediaSource {
    pub fn youtube(video_id: String) -> Self {
        Self {
            kind: SourceKind::Youtube,
            url: format!("https://www.youtube.com/watch?v={video_id}"),
            video_id: Some(video_id),
        }
    }
}

/// Playlist containers. These are not playable themselves — they expand into
/// many sources — so classification reports them separately.
const PLAYLIST_EXTENSIONS: [&str; 2] = ["m3u", "pls"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classified {
    /// A single playable source.
    Source(MediaSource),
    /// A list of sources that must be fetched and expanded first.
    Playlist { url: String },
}

/// Decide what a pasted string is.
///
/// Order matters: YouTube is checked first because a YouTube URL would
/// otherwise fall through to the generic file branch, and `.m3u8` is checked
/// before the playlist extensions because the two share a prefix.
pub fn classify(input: &str) -> Option<Classified> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    // A bare id or any YouTube URL shape.
    if let Some(video_id) = crate::util::parse_video_id(trimmed) {
        return Some(Classified::Source(MediaSource::youtube(video_id)));
    }

    let url = normalize_url(trimmed)?;
    let extension = path_extension(&url);

    // `.m3u8` is ambiguous — it is both the HLS manifest extension and a
    // UTF-8 playlist container — and the two are only distinguishable by
    // content. Treating it as HLS here is the right default: the import path
    // fetches it and reclassifies when it turns out to be a channel list.
    if extension.as_deref() == Some("m3u8") {
        return Some(Classified::Source(MediaSource {
            kind: SourceKind::Hls,
            url,
            video_id: None,
        }));
    }

    if let Some(ext) = extension.as_deref()
        && PLAYLIST_EXTENSIONS.contains(&ext)
    {
        return Some(Classified::Playlist { url });
    }

    if extension.as_deref() == Some("mpd") {
        return Some(Classified::Source(MediaSource {
            kind: SourceKind::Dash,
            url,
            video_id: None,
        }));
    }

    // Everything else is attempted as a media file. An extensionless URL is
    // very often a redirect to one, and refusing it would break the single
    // most common "just paste the stream link" case.
    Some(Classified::Source(MediaSource {
        kind: SourceKind::File,
        url,
        video_id: None,
    }))
}

/// Accept only absolute http(s) URLs, and hand back the parsed form.
///
/// Rejecting other schemes here is a security boundary, not tidiness: `file:`
/// and `gopher:` would be fetched by the import path, and `javascript:` would
/// reach an href on the client.
fn normalize_url(input: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(input).ok()?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    parsed.host_str()?;
    Some(parsed.to_string())
}

/// Lowercased extension of the URL's path, ignoring the query string.
fn path_extension(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let last = parsed.path_segments()?.next_back()?;
    let (_, ext) = last.rsplit_once('.')?;
    (!ext.is_empty() && ext.len() <= 5).then(|| ext.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(input: &str) -> MediaSource {
        match classify(input) {
            Some(Classified::Source(s)) => s,
            other => panic!("expected a source for {input}, got {other:?}"),
        }
    }

    #[test]
    fn youtube_links_and_bare_ids_resolve_to_youtube() {
        for input in [
            "dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        ] {
            let s = source(input);
            assert_eq!(s.kind, SourceKind::Youtube, "failed on {input}");
            assert_eq!(s.video_id.as_deref(), Some("dQw4w9WgXcQ"));
        }
    }

    #[test]
    fn direct_media_urls_are_files() {
        for (input, _) in [
            ("https://example.com/a.mp4", "mp4"),
            ("https://example.com/deep/path/b.webm", "webm"),
            ("http://example.com/song.mp3", "mp3"),
            ("https://example.com/c.mkv?token=abc", "mkv"),
        ] {
            assert_eq!(source(input).kind, SourceKind::File, "failed on {input}");
        }
    }

    #[test]
    fn streaming_manifests_get_their_own_kinds() {
        assert_eq!(source("https://example.com/live.m3u8").kind, SourceKind::Hls);
        assert_eq!(source("https://example.com/v.mpd").kind, SourceKind::Dash);
    }

    #[test]
    fn a_query_string_does_not_hide_the_extension() {
        // The naive `ends_with(".m3u8")` check gets this wrong, and an IPTV
        // link with a token query is the single most common real input.
        assert_eq!(
            source("https://example.com/live.m3u8?token=deadbeef&u=1").kind,
            SourceKind::Hls
        );
    }

    #[test]
    fn playlist_containers_are_reported_separately() {
        for input in [
            "https://example.com/channels.m3u",
            "https://example.com/radio.pls",
        ] {
            assert!(
                matches!(classify(input), Some(Classified::Playlist { .. })),
                "failed on {input}"
            );
        }
    }

    #[test]
    fn unknown_and_extensionless_urls_are_attempted_as_files() {
        // VLC's contract: try it rather than refuse it.
        assert_eq!(source("https://example.com/stream").kind, SourceKind::File);
        assert_eq!(source("https://example.com/a.bin").kind, SourceKind::File);
    }

    #[test]
    fn non_http_schemes_are_refused() {
        // These would otherwise reach the server-side fetcher or a client href.
        for input in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>",
            "gopher://example.com/",
            "not a url at all",
            "",
            "   ",
        ] {
            assert_eq!(classify(input), None, "accepted {input}");
        }
    }

    #[test]
    fn only_streaming_kinds_may_be_live() {
        assert!(SourceKind::Hls.may_be_live());
        assert!(SourceKind::Dash.may_be_live());
        assert!(!SourceKind::File.may_be_live());
        assert!(!SourceKind::Youtube.may_be_live());
    }

    #[test]
    fn kind_strings_round_trip() {
        for kind in [
            SourceKind::Youtube,
            SourceKind::File,
            SourceKind::Hls,
            SourceKind::Dash,
        ] {
            assert_eq!(SourceKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(SourceKind::parse("torrent"), None);
    }
}
