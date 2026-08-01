//! The theme registry.
//!
//! A room's theme is applied to every client in it, so the key has to be
//! validated server-side. Without that, a host could store an arbitrary string
//! that the client then has to interpret — and "interpret an attacker-supplied
//! string as a style" is how a theme picker becomes a CSS injection.
//!
//! The palettes themselves live in the web app (`src/lib/themes.ts`); only the
//! set of valid keys is duplicated here, and the test below is what keeps the
//! two lists honest.

/// Every theme a room may be set to. Must match `THEME_KEYS` in the web app.
pub const THEMES: [&str; 12] = [
    "default",
    "amethyst",
    "amber",
    "bubblegum",
    "caffeine",
    "claymorphism",
    "cosmic",
    "graphite",
    "mono",
    "nature",
    "ocean",
    "sunset",
];

pub const THEME_MODES: [&str; 2] = ["light", "dark"];

pub fn is_valid_theme(key: &str) -> bool {
    THEMES.contains(&key)
}

pub fn is_valid_mode(mode: &str) -> bool {
    THEME_MODES.contains(&mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_theme_is_a_real_theme() {
        // `RoomSettings::default()` and the migration both name this key; if it
        // is not in the registry, every new room is created invalid.
        assert!(is_valid_theme("default"));
        assert!(is_valid_mode("dark"));
    }

    #[test]
    fn unknown_themes_are_refused() {
        for key in [
            "",
            "midnight",
            "MY-THEME",
            "../../etc/passwd",
            "default; background: url(evil)",
        ] {
            assert!(!is_valid_theme(key), "accepted {key:?}");
        }
    }

    #[test]
    fn theme_keys_are_safe_to_interpolate_into_an_attribute() {
        // The client sets `data-theme` from this value. Restricting the
        // alphabet means even a future registry entry cannot break out of the
        // attribute it lands in.
        for key in THEMES {
            assert!(
                !key.is_empty()
                    && key
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '-'),
                "{key} is not a safe theme key"
            );
        }
    }

    #[test]
    fn theme_keys_are_unique() {
        let mut sorted = THEMES.to_vec();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(before, sorted.len(), "duplicate theme key");
    }
}
