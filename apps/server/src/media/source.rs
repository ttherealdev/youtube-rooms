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
    /// Twitch channel or VOD, played through the Twitch embed.
    Twitch,
    /// Kick channel, played through the Kick embed.
    Kick,
}

impl SourceKind {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "youtube" => Some(Self::Youtube),
            "file" => Some(Self::File),
            "hls" => Some(Self::Hls),
            "dash" => Some(Self::Dash),
            "twitch" => Some(Self::Twitch),
            "kick" => Some(Self::Kick),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Youtube => "youtube",
            Self::File => "file",
            Self::Hls => "hls",
            Self::Dash => "dash",
            Self::Twitch => "twitch",
            Self::Kick => "kick",
        }
    }

    /// Live sources have no meaningful duration or seek range, so the room
    /// must not try to auto-advance off the end of one.
    ///
    /// Twitch is included even though it also serves VODs: a channel URL and a
    /// VOD URL are indistinguishable in their effect on the room, and treating
    /// a live channel as seekable is a much worse failure than treating a VOD
    /// as unseekable.
    pub fn may_be_live(self) -> bool {
        matches!(self, Self::Hls | Self::Dash | Self::Twitch | Self::Kick)
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
///
/// `xspf` and `asx` are here because they are what a desktop player exports:
/// someone moving a watchlist over from VLC or Windows Media Player arrives
/// with one of these far more often than with an `.m3u`.
const PLAYLIST_EXTENSIONS: [&str; 4] = ["m3u", "pls", "xspf", "asx"];

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

    let url = rewrite_share_link(&normalize_url(trimmed)?);

    // Platform embeds are matched on host before extension, because these URLs
    // have no extension at all and would otherwise be attempted as files.
    if let Some(source) = classify_platform(&url) {
        return Some(Classified::Source(source));
    }

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

/// Twitch and Kick, which only play inside their own embed.
///
/// Both are matched by host and canonicalised to the shape their embed expects,
/// so the client can read the channel or video straight off the URL rather than
/// re-deriving it from whatever the user happened to paste. Paths that are not
/// channels — Twitch's `/directory`, `/settings`, and so on — fall through and
/// are refused rather than being embedded as a broken player.
fn classify_platform(url: &str) -> Option<MediaSource> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let host = host.trim_start_matches("www.").trim_start_matches("m.");
    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    match host {
        "twitch.tv" | "player.twitch.tv" => match segments.as_slice() {
            // A VOD: twitch.tv/videos/1234567890
            ["videos", id] if is_plain_id(id) => Some(MediaSource {
                kind: SourceKind::Twitch,
                url: format!("https://www.twitch.tv/videos/{id}"),
                video_id: None,
            }),
            // A live channel: twitch.tv/<channel>
            [channel] if is_channel_name(channel) => Some(MediaSource {
                kind: SourceKind::Twitch,
                url: format!("https://www.twitch.tv/{}", channel.to_ascii_lowercase()),
                video_id: None,
            }),
            _ => None,
        },

        // Kick has channels and nothing else worth embedding; its clips and
        // VODs are not addressable through the public player.
        "kick.com" | "player.kick.com" => match segments.as_slice() {
            [channel] if is_channel_name(channel) => Some(MediaSource {
                kind: SourceKind::Kick,
                url: format!("https://kick.com/{}", channel.to_ascii_lowercase()),
                video_id: None,
            }),
            _ => None,
        },

        _ => None,
    }
}

/// Reserved first path segments that are pages, not channels.
///
/// Both platforms reserve these names, so nothing here can collide with a real
/// channel. The list only has to cover what someone might plausibly paste —
/// anything missed embeds a broken player rather than doing harm, and anything
/// over-matched refuses a URL the user can still paste as a direct stream.
const NOT_CHANNELS: [&str; 18] = [
    // Twitch
    "directory",
    "settings",
    "downloads",
    "subscriptions",
    "wallet",
    "drops",
    "friends",
    "videos",
    "clips",
    // Kick
    "browse",
    "categories",
    "following",
    "messages",
    "clips-feed",
    // Both
    "search",
    "about",
    "login",
    "signup",
];

fn is_channel_name(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    !NOT_CHANNELS.contains(&lower.as_str())
        && !lower.is_empty()
        && lower.len() <= 40
        && lower
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_plain_id(segment: &str) -> bool {
    !segment.is_empty() && segment.len() <= 20 && segment.chars().all(|c| c.is_ascii_digit())
}

/// Accept only absolute http(s) URLs, and hand back the parsed form.
///
/// Rejecting other schemes here is a security boundary, not tidiness: `file:`
/// and `gopher:` would be fetched by the import path, and `javascript:` would
/// reach an href on the client.
fn normalize_url(input: &str) -> Option<String> {
    let parsed = match reqwest::Url::parse(input) {
        Ok(parsed) => parsed,
        // People paste `example.com/clip.mp4` and `www.example.com/live.m3u8`
        // constantly. Retrying under https is only done when the input has no
        // scheme at all, so `javascript:` and friends still fail below rather
        // than being rescued into `https://javascript:...`.
        Err(_) if !input.contains("://") && looks_like_host(input) => {
            reqwest::Url::parse(&format!("https://{input}")).ok()?
        }
        Err(_) => return None,
    };

    match parsed.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    parsed.host_str()?;
    Some(parsed.to_string())
}

/// Does this look like `host[/path]` rather than prose or a bare filename?
fn looks_like_host(input: &str) -> bool {
    let host = input.split(['/', '?', '#']).next().unwrap_or_default();
    !host.is_empty()
        && !host.contains(' ')
        && host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
}

/// Turn a "share this file" page URL into something a `<video>` can load.
///
/// Cloud drives hand out links to an HTML viewer, not to the bytes. Pasted as
/// they come, every one of them fails with the browser's opaque "format not
/// supported" — the file is fine, the URL was simply never media. Each provider
/// has a documented direct form, so the rewrite happens here, once, instead of
/// being a support question forever.
///
/// Anything unrecognised is returned untouched.
fn rewrite_share_link(url: &str) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return url.to_string();
    };
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let host = host.trim_start_matches("www.");

    match host {
        // drive.google.com/file/d/<id>/view → the direct download endpoint.
        // Large files answer this with a virus-scan interstitial instead of the
        // bytes, which is a Google policy we cannot route around; small and
        // medium files, which is what people actually share, play.
        "drive.google.com" => {
            let segments: Vec<&str> = parsed.path_segments().map(|s| s.collect()).unwrap_or_default();
            match segments.as_slice() {
                ["file", "d", id, ..] if !id.is_empty() => {
                    format!("https://drive.google.com/uc?export=download&id={id}")
                }
                _ => url.to_string(),
            }
        }

        // Dropbox serves a preview page unless asked otherwise. `raw=1` is the
        // supported form; the older `dl=1` forces a download, which the browser
        // then refuses to treat as media.
        "dropbox.com" | "dl.dropboxusercontent.com" => {
            let mut out = parsed.clone();
            let kept: Vec<(String, String)> = parsed
                .query_pairs()
                .filter(|(key, _)| key != "dl" && key != "raw")
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            out.query_pairs_mut()
                .clear()
                .extend_pairs(kept)
                .append_pair("raw", "1");
            out.to_string()
        }

        _ => url.to_string(),
    }
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
    fn a_missing_scheme_is_assumed_to_be_https() {
        // Copying a URL out of a chat message very often loses the scheme.
        assert_eq!(source("example.com/clip.mp4").kind, SourceKind::File);
        assert_eq!(source("www.example.com/live.m3u8").kind, SourceKind::Hls);
        assert!(source("example.com/clip.mp4").url.starts_with("https://"));
    }

    #[test]
    fn desktop_player_playlists_are_recognised() {
        for input in [
            "https://example.com/list.xspf",
            "https://example.com/stations.asx",
        ] {
            assert!(
                matches!(classify(input), Some(Classified::Playlist { .. })),
                "failed on {input}"
            );
        }
    }

    #[test]
    fn cloud_share_links_become_direct_media_urls() {
        let drive = source("https://drive.google.com/file/d/1AbCdEfGhIjK/view?usp=sharing");
        assert_eq!(drive.url, "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjK");

        // The preview page would otherwise reach a <video> as HTML.
        let dropbox = source("https://www.dropbox.com/s/abc123/clip.mp4?dl=0");
        assert!(dropbox.url.contains("raw=1"), "got {}", dropbox.url);
        assert!(!dropbox.url.contains("dl=0"), "got {}", dropbox.url);
    }

    #[test]
    fn an_unrecognised_host_is_left_exactly_as_pasted() {
        // The rewrite must be a narrow allowlist: silently rewriting arbitrary
        // URLs would break every self-hosted link.
        let url = "https://example.com/a.mp4?dl=0&token=x";
        assert_eq!(source(url).url, url);
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
        assert!(SourceKind::Twitch.may_be_live());
        assert!(SourceKind::Kick.may_be_live());
        assert!(!SourceKind::File.may_be_live());
        assert!(!SourceKind::Youtube.may_be_live());
    }

    #[test]
    fn twitch_channels_and_vods_are_canonicalised() {
        for input in [
            "https://twitch.tv/Shroud",
            "https://www.twitch.tv/shroud",
            "https://m.twitch.tv/shroud",
            "twitch.tv/shroud",
        ] {
            let s = source(input);
            assert_eq!(s.kind, SourceKind::Twitch, "failed on {input}");
            // Canonical and lowercased, so the client never has to re-derive it.
            assert_eq!(s.url, "https://www.twitch.tv/shroud", "failed on {input}");
        }

        let vod = source("https://www.twitch.tv/videos/1234567890");
        assert_eq!(vod.kind, SourceKind::Twitch);
        assert_eq!(vod.url, "https://www.twitch.tv/videos/1234567890");
    }

    #[test]
    fn kick_channels_are_canonicalised() {
        for input in ["https://kick.com/Xqc", "kick.com/xqc", "https://www.kick.com/xqc"] {
            let s = source(input);
            assert_eq!(s.kind, SourceKind::Kick, "failed on {input}");
            assert_eq!(s.url, "https://kick.com/xqc", "failed on {input}");
        }
    }

    #[test]
    fn platform_pages_that_are_not_channels_are_refused() {
        // Embedding these yields a broken player rather than an error, which is
        // a worse outcome than refusing the paste.
        for input in [
            "https://www.twitch.tv/directory/game/Chess",
            "https://www.twitch.tv/settings",
            "https://kick.com/browse",
            "https://www.twitch.tv/videos/not-a-number",
        ] {
            let classified = classify(input);
            assert!(
                !matches!(
                    classified,
                    Some(Classified::Source(MediaSource {
                        kind: SourceKind::Twitch | SourceKind::Kick,
                        ..
                    }))
                ),
                "embedded {input} as a channel: {classified:?}"
            );
        }
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
