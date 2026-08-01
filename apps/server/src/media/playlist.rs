//! Playlist parsing.
//!
//! "Paste a list URL and load everything on it" is the IPTV/VLC workflow, and
//! the two formats that carry those lists in practice are extended M3U and PLS.
//! Both are line-oriented text, so this module is pure string handling and is
//! tested exhaustively without a network.
//!
//! The subtle part is `.m3u8`. That extension names *two* different things: an
//! HLS manifest, which is a single stream, and a UTF-8 playlist container,
//! which is a list of streams. They are only distinguishable by content, so
//! [`parse`] reports which one it found rather than guessing from the URL.

use super::source::{MediaSource, SourceKind, classify};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaylistEntry {
    pub title: String,
    pub source: MediaSource,
    pub logo: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    /// A list of playable sources.
    Entries(Vec<PlaylistEntry>),
    /// The body was an HLS manifest after all: one stream, not a list.
    HlsManifest,
}

/// Cap on how many entries one import may produce.
///
/// Public IPTV lists routinely carry tens of thousands of channels. Without a
/// ceiling a single paste writes that many rows and broadcasts a queue snapshot
/// nobody can render.
pub const MAX_ENTRIES: usize = 500;

/// Parse a playlist body.
///
/// `base` is the URL the body was fetched from, used to resolve relative
/// entries — common in M3U files exported by media servers.
pub fn parse(body: &str, base: &str) -> Parsed {
    if is_hls_manifest(body) {
        return Parsed::HlsManifest;
    }

    let trimmed = body.trim_start();
    if trimmed.starts_with("[playlist]") || trimmed.starts_with("[Playlist]") {
        return Parsed::Entries(parse_pls(body, base));
    }

    Parsed::Entries(parse_m3u(body, base))
}

/// An HLS manifest is any body carrying `#EXT-X-` tags.
///
/// Those tags exist only in HLS; an IPTV channel list uses `#EXTINF` alone.
/// Checking for the tag family rather than a specific one covers both master
/// playlists (`#EXT-X-STREAM-INF`) and media playlists
/// (`#EXT-X-TARGETDURATION`), including future tags.
fn is_hls_manifest(body: &str) -> bool {
    body.lines().any(|line| line.trim_start().starts_with("#EXT-X-"))
}

fn parse_m3u(body: &str, base: &str) -> Vec<PlaylistEntry> {
    let mut entries = Vec::new();
    // Metadata from the most recent `#EXTINF`, applied to the next URL line.
    let mut pending: Option<(String, Option<String>, Option<String>)> = None;

    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            pending = Some(parse_extinf(rest));
            continue;
        }

        // Any other directive is metadata we do not model; it must not be
        // mistaken for a URL.
        if line.starts_with('#') {
            continue;
        }

        let (title, logo, group) = pending.take().unwrap_or((String::new(), None, None));

        let Some(source) = resolve_entry(line, base) else {
            continue;
        };

        entries.push(PlaylistEntry {
            title: if title.is_empty() {
                fallback_title(&source)
            } else {
                title
            },
            source,
            logo,
            group,
        });

        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }

    entries
}

/// `#EXTINF:-1 tvg-logo="…" group-title="…",Channel Name`
///
/// The attribute block is optional and unordered, and the display name is
/// everything after the last comma that is not inside a quoted attribute.
fn parse_extinf(rest: &str) -> (String, Option<String>, Option<String>) {
    // Split at the first comma that is not inside quotes. Splitting naively on
    // the first comma truncates any channel whose attributes contain one.
    let mut in_quotes = false;
    let mut split_at = None;
    for (index, ch) in rest.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                split_at = Some(index);
                break;
            }
            _ => {}
        }
    }

    let (attributes, title) = match split_at {
        Some(index) => (&rest[..index], rest[index + 1..].trim()),
        None => (rest, ""),
    };

    (
        title.to_string(),
        attribute(attributes, "tvg-logo"),
        attribute(attributes, "group-title"),
    )
}

/// Pull `name="value"` out of an EXTINF attribute block.
fn attribute(attributes: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = attributes.find(&key)? + key.len();
    let rest = &attributes[start..];
    let end = rest.find('"')?;
    let value = &rest[..end];
    (!value.is_empty()).then(|| value.to_string())
}

/// `[playlist]` / `FileN=` / `TitleN=` — the Winamp format, still standard for
/// internet radio directories.
fn parse_pls(body: &str, base: &str) -> Vec<PlaylistEntry> {
    use std::collections::BTreeMap;

    let mut files: BTreeMap<u32, String> = BTreeMap::new();
    let mut titles: BTreeMap<u32, String> = BTreeMap::new();

    for raw in body.lines() {
        let line = raw.trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }

        let lower = key.to_ascii_lowercase();
        if let Some(index) = lower.strip_prefix("file").and_then(|n| n.parse().ok()) {
            files.insert(index, value.to_string());
        } else if let Some(index) = lower.strip_prefix("title").and_then(|n| n.parse().ok()) {
            titles.insert(index, value.to_string());
        }
    }

    // A BTreeMap keyed on the entry number restores the author's intended
    // order even when the file interleaves File/Title lines arbitrarily.
    files
        .into_iter()
        .filter_map(|(index, url)| {
            let source = resolve_entry(&url, base)?;
            Some(PlaylistEntry {
                title: titles
                    .get(&index)
                    .cloned()
                    .unwrap_or_else(|| fallback_title(&source)),
                source,
                logo: None,
                group: None,
            })
        })
        .take(MAX_ENTRIES)
        .collect()
}

/// Turn one playlist line into a source, resolving relative URLs against the
/// playlist's own location.
fn resolve_entry(line: &str, base: &str) -> Option<MediaSource> {
    let absolute = match reqwest::Url::parse(line) {
        Ok(url) => url.to_string(),
        // Relative entry: join it onto the playlist URL.
        Err(_) => reqwest::Url::parse(base).ok()?.join(line).ok()?.to_string(),
    };

    match classify(&absolute)? {
        super::source::Classified::Source(source) => Some(source),
        // A playlist that lists another playlist is not expanded. One level is
        // what users mean, and recursing invites both loops and amplification.
        super::source::Classified::Playlist { .. } => None,
    }
}

/// Last path segment, so an untitled entry still reads as something.
fn fallback_title(source: &MediaSource) -> String {
    reqwest::Url::parse(&source.url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut s| s.next_back())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| match source.kind {
            SourceKind::Hls | SourceKind::Dash => "Live stream".to_string(),
            _ => "Untitled".to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://lists.example.com/tv/channels.m3u";

    fn entries(body: &str) -> Vec<PlaylistEntry> {
        match parse(body, BASE) {
            Parsed::Entries(entries) => entries,
            Parsed::HlsManifest => panic!("expected entries, got an HLS manifest"),
        }
    }

    #[test]
    fn extended_m3u_yields_titled_entries() {
        let body = "#EXTM3U\n\
                    #EXTINF:-1,News One\n\
                    https://cdn.example.com/news.m3u8\n\
                    #EXTINF:-1,Movies HD\n\
                    https://cdn.example.com/movies.m3u8\n";

        let got = entries(body);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].title, "News One");
        assert_eq!(got[0].source.kind, SourceKind::Hls);
        assert_eq!(got[1].title, "Movies HD");
    }

    #[test]
    fn extinf_attributes_are_captured() {
        let body = "#EXTM3U\n\
                    #EXTINF:-1 tvg-id=\"n1\" tvg-logo=\"https://img.example.com/n1.png\" group-title=\"News\",News One\n\
                    https://cdn.example.com/news.m3u8\n";

        let got = entries(body);
        assert_eq!(got[0].logo.as_deref(), Some("https://img.example.com/n1.png"));
        assert_eq!(got[0].group.as_deref(), Some("News"));
        assert_eq!(got[0].title, "News One");
    }

    #[test]
    fn a_comma_inside_an_attribute_does_not_truncate_the_title() {
        // Splitting on the first comma is the classic bug here, and channel
        // names with commas in their group are common in real lists.
        let body = "#EXTM3U\n\
                    #EXTINF:-1 group-title=\"News, World\",BBC One\n\
                    https://cdn.example.com/bbc.m3u8\n";

        let got = entries(body);
        assert_eq!(got[0].title, "BBC One");
        assert_eq!(got[0].group.as_deref(), Some("News, World"));
    }

    #[test]
    fn an_hls_manifest_is_not_treated_as_a_channel_list() {
        // This is the whole reason `.m3u8` cannot be classified by extension:
        // these segment URLs are not separate videos.
        let media = "#EXTM3U\n\
                     #EXT-X-VERSION:3\n\
                     #EXT-X-TARGETDURATION:10\n\
                     #EXTINF:10.0,\n\
                     segment0.ts\n\
                     #EXTINF:10.0,\n\
                     segment1.ts\n";
        assert_eq!(parse(media, BASE), Parsed::HlsManifest);

        let master = "#EXTM3U\n\
                      #EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480\n\
                      720p.m3u8\n";
        assert_eq!(parse(master, BASE), Parsed::HlsManifest);
    }

    #[test]
    fn relative_entries_resolve_against_the_playlist_url() {
        let body = "#EXTM3U\n#EXTINF:-1,Local\n../media/clip.mp4\n";
        let got = entries(body);
        assert_eq!(got[0].source.url, "https://lists.example.com/media/clip.mp4");
    }

    #[test]
    fn a_plain_m3u_without_directives_still_parses() {
        let body = "https://cdn.example.com/a.mp4\nhttps://cdn.example.com/b.mp4\n";
        let got = entries(body);
        assert_eq!(got.len(), 2);
        // No EXTINF, so the filename is the best title available.
        assert_eq!(got[0].title, "a.mp4");
    }

    #[test]
    fn pls_files_parse_and_keep_their_numbering() {
        let body = "[playlist]\n\
                    NumberOfEntries=2\n\
                    File2=https://radio.example.com/two.mp3\n\
                    Title2=Second\n\
                    File1=https://radio.example.com/one.mp3\n\
                    Title1=First\n";

        let got = entries(body);
        assert_eq!(got.len(), 2);
        // Ordered by entry number, not by line order.
        assert_eq!(got[0].title, "First");
        assert_eq!(got[1].title, "Second");
    }

    #[test]
    fn unusable_and_nested_entries_are_skipped_not_fatal() {
        let body = "#EXTM3U\n\
                    #EXTINF:-1,Bad scheme\n\
                    file:///etc/passwd\n\
                    #EXTINF:-1,Nested list\n\
                    https://example.com/other.m3u\n\
                    #EXTINF:-1,Good\n\
                    https://cdn.example.com/ok.mp4\n";

        let got = entries(body);
        assert_eq!(got.len(), 1, "only the playable entry survives");
        assert_eq!(got[0].title, "Good");
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let body = "#EXTM3U\n\n# just a comment\n#PLAYLIST:My list\n\
                    #EXTINF:-1,Only\nhttps://cdn.example.com/only.mp4\n\n";
        assert_eq!(entries(body).len(), 1);
    }

    #[test]
    fn imports_are_capped() {
        // A public IPTV list with tens of thousands of channels must not turn
        // into tens of thousands of rows and an unrenderable queue.
        let mut body = String::from("#EXTM3U\n");
        for n in 0..(MAX_ENTRIES + 250) {
            body.push_str(&format!("#EXTINF:-1,Channel {n}\nhttps://cdn.example.com/{n}.m3u8\n"));
        }
        assert_eq!(entries(&body).len(), MAX_ENTRIES);
    }

    #[test]
    fn an_empty_body_yields_no_entries_rather_than_an_error() {
        assert!(entries("").is_empty());
        assert!(entries("#EXTM3U\n").is_empty());
    }
}
