//! Session cookie construction.
//!
//! Centralised so the security attributes are decided once. A cookie built
//! ad-hoc in a handler is how `Secure` goes missing on one path.

use crate::config::AuthConfig;
use axum_extra::extract::cookie::{Cookie, SameSite};

pub const REFRESH_COOKIE: &str = "yr_refresh";
pub const OAUTH_STATE_COOKIE: &str = "yr_oauth_state";

/// The refresh cookie.
///
/// * `HttpOnly` — unreadable from JavaScript, so an XSS cannot exfiltrate the
///   session. This is the whole reason the refresh token is not in memory.
/// * `SameSite=Lax` — blocks cross-site POSTs while still allowing the
///   top-level navigation that returns from Google's consent screen.
/// * `Path=/api/auth` — the cookie is only ever needed by the refresh and
///   logout endpoints, so it is not attached to every other API request.
pub fn refresh_cookie<'a>(config: &AuthConfig, value: String) -> Cookie<'a> {
    let mut cookie = Cookie::new(REFRESH_COOKIE, value);
    cookie.set_http_only(true);
    cookie.set_secure(config.cookie_secure);
    cookie.set_same_site(SameSite::Lax);
    cookie.set_path("/api/auth");
    cookie.set_max_age(
        time::Duration::try_from(config.refresh_token_ttl).unwrap_or(time::Duration::days(30)),
    );
    if let Some(domain) = &config.cookie_domain {
        cookie.set_domain(domain.clone());
    }
    cookie
}

/// A removal cookie must match the original's path and domain exactly, or the
/// browser keeps the old one and "sign out" silently does nothing.
pub fn clear_refresh_cookie<'a>(config: &AuthConfig) -> Cookie<'a> {
    let mut cookie = Cookie::new(REFRESH_COOKIE, "");
    cookie.set_http_only(true);
    cookie.set_secure(config.cookie_secure);
    cookie.set_same_site(SameSite::Lax);
    cookie.set_path("/api/auth");
    cookie.set_max_age(time::Duration::seconds(0));
    if let Some(domain) = &config.cookie_domain {
        cookie.set_domain(domain.clone());
    }
    cookie
}

/// Holds the OAuth `state` for the duration of the redirect to Google.
///
/// Short-lived and scoped to the callback path. Pairing this with the copy in
/// Redis means an attacker who can forge a callback URL still cannot supply the
/// matching cookie.
pub fn oauth_state_cookie<'a>(config: &AuthConfig, state: String) -> Cookie<'a> {
    let mut cookie = Cookie::new(OAUTH_STATE_COOKIE, state);
    cookie.set_http_only(true);
    cookie.set_secure(config.cookie_secure);
    cookie.set_same_site(SameSite::Lax);
    cookie.set_path("/api/auth");
    cookie.set_max_age(time::Duration::minutes(10));
    if let Some(domain) = &config.cookie_domain {
        cookie.set_domain(domain.clone());
    }
    cookie
}

pub fn clear_oauth_state_cookie<'a>(config: &AuthConfig) -> Cookie<'a> {
    let mut cookie = Cookie::new(OAUTH_STATE_COOKIE, "");
    cookie.set_http_only(true);
    cookie.set_secure(config.cookie_secure);
    cookie.set_same_site(SameSite::Lax);
    cookie.set_path("/api/auth");
    cookie.set_max_age(time::Duration::seconds(0));
    if let Some(domain) = &config.cookie_domain {
        cookie.set_domain(domain.clone());
    }
    cookie
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn config(secure: bool) -> AuthConfig {
        AuthConfig {
            jwt_private_pem: String::new(),
            jwt_public_pem: String::new(),
            access_token_ttl: Duration::from_secs(900),
            refresh_token_ttl: Duration::from_secs(86_400),
            ws_ticket_ttl: Duration::from_secs(30),
            cookie_domain: Some("example.com".into()),
            cookie_secure: secure,
        }
    }

    #[test]
    fn refresh_cookie_is_locked_down() {
        let cookie = refresh_cookie(&config(true), "token".into());
        assert!(cookie.http_only().unwrap_or(false));
        assert!(cookie.secure().unwrap_or(false));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert_eq!(cookie.path(), Some("/api/auth"));
    }

    #[test]
    fn clearing_matches_the_original_scope() {
        let set = refresh_cookie(&config(true), "token".into());
        let clear = clear_refresh_cookie(&config(true));
        // A mismatch on either attribute leaves the original cookie in place.
        assert_eq!(set.path(), clear.path());
        assert_eq!(set.domain(), clear.domain());
        assert_eq!(clear.value(), "");
    }

    #[test]
    fn secure_flag_follows_configuration() {
        assert!(!refresh_cookie(&config(false), "t".into()).secure().unwrap_or(true));
    }
}
