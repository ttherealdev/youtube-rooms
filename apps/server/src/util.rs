//! Small pure helpers. Everything here is deterministic and unit-tested —
//! these are the functions whose subtle breakage is hardest to notice in the UI.

use rand::Rng;

/// Milliseconds since the Unix epoch, as the server sees it. This is *the*
/// clock the whole synchronisation design is anchored to (ADR 0005), so it is
/// defined in exactly one place.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Up to two initials from a display name: "Anas Mohamed" → "AM", "cher" → "C".
///
/// Grapheme-naive on purpose — we take the first `char` of the first and last
/// whitespace-separated tokens, which is correct for the overwhelming majority
/// of names and never panics on multi-byte input.
pub fn initials(display_name: &str) -> String {
    let tokens: Vec<&str> = display_name
        .split_whitespace()
        .filter(|t| t.chars().any(char::is_alphanumeric))
        .collect();

    let pick = |token: &str| -> Option<char> {
        token
            .chars()
            .find(|c| c.is_alphanumeric())
            .map(|c| c.to_uppercase().next().unwrap_or(c))
    };

    match tokens.as_slice() {
        [] => "?".to_string(),
        [only] => pick(only).map(String::from).unwrap_or_else(|| "?".into()),
        [first, .., last] => {
            let mut out = String::new();
            if let Some(c) = pick(first) {
                out.push(c);
            }
            if let Some(c) = pick(last) {
                out.push(c);
            }
            if out.is_empty() { "?".into() } else { out }
        }
    }
}

/// Stable hue in [0, 360) derived from a UUID, so a given user always gets the
/// same generated avatar gradient without storing anything.
///
/// FNV-1a rather than a cryptographic hash: we need distribution, not secrecy,
/// and this is called for every participant on every snapshot.
pub fn avatar_hue(id: &uuid::Uuid) -> u16 {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    let mut hash = FNV_OFFSET;
    for byte in id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    (hash % 360) as u16
}

/// Human-shareable room code: `k3f9-2mxq-71ab`.
///
/// The alphabet omits characters that are ambiguous when read aloud or
/// transcribed (0/o, 1/l/i) because these codes get typed from a screenshot.
pub fn generate_room_slug() -> String {
    const ALPHABET: &[u8] = b"23456789abcdefghjkmnpqrstuvwxyz";
    let mut rng = rand::rng();
    let mut out = String::with_capacity(14);
    for group in 0..3 {
        if group > 0 {
            out.push('-');
        }
        for _ in 0..4 {
            let idx = rng.random_range(0..ALPHABET.len());
            out.push(ALPHABET[idx] as char);
        }
    }
    out
}

/// URL-safe random token, base64 without padding.
pub fn random_token(bytes: usize) -> String {
    use base64::Engine as _;
    let mut buf = vec![0u8; bytes];
    rand::rng().fill(buf.as_mut_slice());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

pub fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Fractional position for an item dropped between `before` and `after`.
///
/// Reordering a queue by renumbering every row is O(n) writes and races badly
/// with concurrent drags. Midpoint insertion makes a reorder exactly one UPDATE.
///
/// `None` for either bound means "at the end of the list in that direction".
pub fn fractional_position(before: Option<f64>, after: Option<f64>) -> f64 {
    const GAP: f64 = 1024.0;
    match (before, after) {
        (None, None) => GAP,
        (None, Some(a)) => a - GAP,
        (Some(b), None) => b + GAP,
        (Some(b), Some(a)) => (b + a) / 2.0,
    }
}

/// True when two fractional positions have converged far enough that further
/// midpoints would lose precision, and the list needs renumbering.
///
/// f64 has ~52 bits of mantissa; repeated halving between two neighbours
/// exhausts that after roughly 50 inserts in the same gap. We rebalance well
/// before that.
pub fn needs_rebalance(before: f64, after: f64) -> bool {
    (after - before).abs() < 1e-6
}

/// Extract a video id from anything a user is likely to paste.
pub fn parse_video_id(input: &str) -> Option<String> {
    let trimmed = input.trim();

    let is_id = |s: &str| {
        s.len() == 11
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };

    if is_id(trimmed) {
        return Some(trimmed.to_owned());
    }

    // youtu.be/<id>, /watch?v=<id>, /embed/<id>, /shorts/<id>, /live/<id>
    let without_scheme = trimmed
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.");

    if let Some(rest) = without_scheme.strip_prefix("youtu.be/") {
        let candidate = rest.split(['?', '&', '#', '/']).next().unwrap_or("");
        return is_id(candidate).then(|| candidate.to_owned());
    }

    if without_scheme.starts_with("youtube.com/") || without_scheme.starts_with("m.youtube.com/") {
        let path_and_query = without_scheme.split_once('/').map(|(_, r)| r).unwrap_or("");

        for prefix in ["embed/", "shorts/", "live/", "v/"] {
            if let Some(rest) = path_and_query.strip_prefix(prefix) {
                let candidate = rest.split(['?', '&', '#', '/']).next().unwrap_or("");
                return is_id(candidate).then(|| candidate.to_owned());
            }
        }

        if let Some((_, query)) = path_and_query.split_once('?') {
            for pair in query.split('&') {
                if let Some(value) = pair.strip_prefix("v=") {
                    let candidate = value.split('#').next().unwrap_or("");
                    return is_id(candidate).then(|| candidate.to_owned());
                }
            }
        }
    }

    None
}

/// Collapse runs of whitespace and trim — applied to every user-supplied name
/// so " Anas   Mohamed " and "Anas Mohamed" cannot masquerade as two people.
pub fn normalize_display_name(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_cover_the_shapes_that_actually_occur() {
        assert_eq!(initials("Anas Mohamed"), "AM");
        assert_eq!(initials("cher"), "C");
        assert_eq!(initials("  jean-luc   picard  "), "JP");
        assert_eq!(initials("Ada B. Lovelace"), "AL");
        assert_eq!(initials(""), "?");
        assert_eq!(initials("   "), "?");
        assert_eq!(initials("!!!"), "?");
        assert_eq!(initials("日本 太郎"), "日太");
        assert_eq!(initials("😀 friend"), "F");
    }

    #[test]
    fn avatar_hue_is_stable_and_in_range() {
        let id = uuid::Uuid::parse_str("00000000-0000-0000-0000-000000000001").unwrap();
        let hue = avatar_hue(&id);
        assert_eq!(hue, avatar_hue(&id));
        assert!(hue < 360);
    }

    #[test]
    fn avatar_hue_spreads_across_the_wheel() {
        // A hash that clustered would make every avatar the same colour.
        let hues: std::collections::HashSet<u16> =
            (0..64).map(|_| avatar_hue(&uuid::Uuid::new_v4())).collect();
        assert!(hues.len() > 40, "expected spread, got {} distinct", hues.len());
    }

    #[test]
    fn room_slug_shape_and_alphabet() {
        let slug = generate_room_slug();
        assert_eq!(slug.len(), 14);
        let groups: Vec<&str> = slug.split('-').collect();
        assert_eq!(groups.len(), 3);
        assert!(groups.iter().all(|g| g.len() == 4));
        // Ambiguous glyphs must never appear.
        assert!(!slug.contains(['0', 'o', '1', 'l', 'i']));
    }

    #[test]
    fn fractional_positions_stay_ordered() {
        assert_eq!(fractional_position(None, None), 1024.0);
        assert_eq!(fractional_position(Some(10.0), Some(20.0)), 15.0);
        assert!(fractional_position(None, Some(0.0)) < 0.0);
        assert!(fractional_position(Some(100.0), None) > 100.0);
    }

    #[test]
    fn rebalance_triggers_only_when_precision_is_nearly_gone() {
        assert!(!needs_rebalance(1.0, 2.0));
        assert!(needs_rebalance(1.0, 1.0000001));
    }

    #[test]
    fn parses_every_youtube_url_shape_users_paste() {
        let expected = Some("dQw4w9WgXcQ".to_string());
        for input in [
            "dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
            "http://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?t=30",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ",
            "  https://youtu.be/dQw4w9WgXcQ  ",
        ] {
            assert_eq!(parse_video_id(input), expected, "failed on {input}");
        }
    }

    #[test]
    fn rejects_non_video_input() {
        for input in [
            "",
            "not a url",
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/tooshort",
            "https://www.youtube.com/watch?v=waaaaaaaaytoolong",
        ] {
            assert_eq!(parse_video_id(input), None, "should reject {input}");
        }
    }

    #[test]
    fn display_names_are_collapsed() {
        assert_eq!(normalize_display_name("  Anas   Mohamed "), "Anas Mohamed");
    }

    #[test]
    fn tokens_are_unique_and_url_safe() {
        let a = random_token(32);
        let b = random_token(32);
        assert_ne!(a, b);
        assert!(!a.contains(['+', '/', '=']));
    }
}
