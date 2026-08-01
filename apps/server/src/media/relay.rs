//! Relaying streams that refuse cross-origin playback.
//!
//! Most public IPTV sources answer with a fixed `Access-Control-Allow-Origin`
//! naming their own site — Pluto's stitcher sends `http://pluto.tv` — which
//! means no browser anywhere else may fetch the manifest, however valid the
//! link is. The stream is fine; the *browser* is not allowed to have it. The
//! only way to play one from a web page is for the server to fetch it and hand
//! it on from an origin the page is allowed to talk to.
//!
//! This module is the rewriting half, kept pure so every substitution is
//! testable without a network. The transport half lives in `fetch::open_stream`
//! and the handlers in `routes`.
//!
//! Relaying is a fallback, not the default: a stream that plays directly is
//! played directly, and never costs us bandwidth.

/// Rewrite every URL in an HLS manifest to point back at the relay.
///
/// Two kinds of reference need catching, and missing either one breaks
/// playback in a way that looks like a corrupt stream:
///
///   * bare URI lines, which are segments or variant playlists;
///   * `URI="…"` attributes on tags — encryption keys (`EXT-X-KEY`),
///     initialisation segments (`EXT-X-MAP`), alternate renditions
///     (`EXT-X-MEDIA`) and trick-play streams (`EXT-X-I-FRAME-STREAM-INF`).
///
/// Everything is resolved against `base` first, because manifests are full of
/// relative references and the relay only deals in absolute URLs.
pub fn rewrite_manifest(
    body: &str,
    base: &str,
    manifest_route: &str,
    segment_route: &str,
) -> String {
    let base = reqwest::Url::parse(base).ok();

    let absolute = |reference: &str| -> Option<String> {
        let trimmed = reference.trim();
        if trimmed.is_empty() {
            return None;
        }
        match base.as_ref() {
            Some(base) => base.join(trimmed).ok().map(|url| url.to_string()),
            None => reqwest::Url::parse(trimmed).ok().map(|url| url.to_string()),
        }
    };

    // A nested playlist has to come back through the rewriter, or its own
    // segments point straight at an origin the browser cannot reach.
    let route_for = |url: &str| if is_playlist(url) { manifest_route } else { segment_route };

    let mut out = String::with_capacity(body.len() + body.len() / 2);

    for line in body.lines() {
        let trimmed = line.trim_end_matches('\r');

        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix('#') {
            out.push_str(&rewrite_tag(rest, &absolute, manifest_route, segment_route));
            out.push('\n');
            continue;
        }

        match absolute(trimmed) {
            Some(url) => {
                out.push_str(&proxied(route_for(&url), &url));
            }
            // Unparseable, so passed through untouched: a manifest we do not
            // understand should fail as itself, not as our mangling of it.
            None => out.push_str(trimmed),
        }
        out.push('\n');
    }

    out
}

/// Rewrite the `URI="…"` attribute of a tag line, if it has one.
fn rewrite_tag(
    rest: &str,
    absolute: &impl Fn(&str) -> Option<String>,
    manifest_route: &str,
    segment_route: &str,
) -> String {
    let Some(start) = find_uri_attribute(rest) else {
        return format!("#{rest}");
    };

    let after = &rest[start..];
    let Some(end) = after.find('"') else {
        return format!("#{rest}");
    };

    let reference = &after[..end];
    let Some(url) = absolute(reference) else {
        return format!("#{rest}");
    };

    let route = if is_playlist(&url) { manifest_route } else { segment_route };

    format!("#{}{}{}", &rest[..start], proxied(route, &url), &after[end..])
}

/// Byte offset just past `URI="`, matched case-insensitively on a word
/// boundary so `EXT-X-SESSION-KEY` is caught but a channel named `URI="` in a
/// title is not.
fn find_uri_attribute(rest: &str) -> Option<usize> {
    let upper = rest.to_ascii_uppercase();
    let mut from = 0usize;

    while let Some(found) = upper[from..].find("URI=\"") {
        let at = from + found;
        let preceded_by_word = at > 0
            && upper.as_bytes()[at - 1].is_ascii_alphanumeric();
        if !preceded_by_word {
            return Some(at + 5);
        }
        from = at + 5;
    }

    None
}

/// Is this reference another playlist rather than media?
///
/// Checked on the path alone: these URLs carry long query strings, and a token
/// containing `.ts` would otherwise route a playlist to the segment handler.
fn is_playlist(url: &str) -> bool {
    let path = reqwest::Url::parse(url)
        .map(|parsed| parsed.path().to_ascii_lowercase())
        .unwrap_or_else(|_| url.to_ascii_lowercase());

    path.ends_with(".m3u8") || path.ends_with(".m3u")
}

fn proxied(route: &str, url: &str) -> String {
    format!("{route}?url={}", urlencoding_encode(url))
}

/// Percent-encode for a query parameter value.
///
/// Hand-rolled rather than pulled in: the set of characters that must not
/// survive into a query value is small and fixed, and the encoding has to
/// round-trip exactly what the manifest contained.
fn urlencoding_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://cdn.example.com/live/master.m3u8";
    const MANIFEST: &str = "/api/stream/manifest";
    const SEGMENT: &str = "/api/stream/segment";

    fn rewrite(body: &str) -> String {
        rewrite_manifest(body, BASE, MANIFEST, SEGMENT)
    }

    #[test]
    fn variant_playlists_route_back_through_the_manifest_handler() {
        // Otherwise the variant's own segments point at an origin the browser
        // is not allowed to reach, and playback dies one level down.
        let out = rewrite("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p.m3u8\n");
        assert!(
            out.contains("/api/stream/manifest?url=https%3A%2F%2Fcdn.example.com%2Flive%2F720p.m3u8"),
            "got {out}"
        );
    }

    #[test]
    fn segments_route_through_the_segment_handler() {
        let out = rewrite("#EXTINF:6,\nseg1.ts\n");
        assert!(out.contains("/api/stream/segment?url="), "got {out}");
        assert!(!out.contains("/api/stream/manifest?url="), "got {out}");
    }

    #[test]
    fn relative_references_resolve_against_the_final_url() {
        let out = rewrite("#EXTINF:6,\n../other/seg1.ts\n");
        assert!(out.contains("cdn.example.com%2Fother%2Fseg1.ts"), "got {out}");
    }

    #[test]
    fn absolute_references_are_kept_as_they_are() {
        let out = rewrite("#EXTINF:6,\nhttps://other.example.net/a.ts\n");
        assert!(out.contains("other.example.net%2Fa.ts"), "got {out}");
    }

    #[test]
    fn key_and_map_uris_are_rewritten_too() {
        // A stream whose key request is left pointing at the origin decrypts to
        // noise, which presents as a corrupt file rather than as a CORS error.
        let out = rewrite(
            "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x0\n\
             #EXT-X-MAP:URI=\"init.mp4\"\n\
             #EXTINF:6,\nseg1.m4s\n",
        );
        assert!(out.contains("URI=\"/api/stream/segment?url="), "got {out}");
        assert_eq!(out.matches("/api/stream/segment?url=").count(), 3, "got {out}");
        // The rest of the tag must survive intact.
        assert!(out.contains(",IV=0x0"), "got {out}");
        assert!(out.contains("METHOD=AES-128"), "got {out}");
    }

    #[test]
    fn media_tags_pointing_at_playlists_route_to_the_manifest_handler() {
        let out = rewrite(
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"English\",URI=\"audio/en.m3u8\"\n",
        );
        assert!(out.contains("URI=\"/api/stream/manifest?url="), "got {out}");
    }

    #[test]
    fn a_query_string_does_not_decide_the_route() {
        // Pluto's URLs carry a JWT; a `.ts` inside one must not make a playlist
        // look like a segment.
        let out = rewrite("#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8?token=aa.ts.bb\n");
        assert!(out.contains("/api/stream/manifest?url="), "got {out}");
    }

    #[test]
    fn tags_without_a_uri_are_untouched() {
        let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n";
        assert_eq!(rewrite(body), body);
    }

    #[test]
    fn comments_mentioning_uri_are_not_mistaken_for_attributes() {
        let out = rewrite("#EXT-X-CUSTOM:MYURI=\"nope.ts\"\n");
        assert!(!out.contains("/api/stream/"), "got {out}");
    }

    #[test]
    fn an_unparseable_line_is_passed_through_rather_than_mangled() {
        let out = rewrite("#EXTINF:6,\n   \n");
        assert!(!out.contains("/api/stream/"), "got {out}");
    }
}
