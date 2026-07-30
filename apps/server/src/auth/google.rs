//! Google Sign-In: authorization code flow with PKCE.
//!
//! Implemented directly rather than through an OAuth crate (ADR 0007). The flow
//! is one authorize URL and one token POST; a dependency would add a second
//! `reqwest` tree and hide the parts we most want to be able to audit.
//!
//! ## Scopes
//!
//! `openid email profile` and nothing else. We deliberately do not request
//! `youtube.readonly`: it pushes the consent screen into a restricted tier
//! requiring annual third-party security assessment, and asking people to hand
//! over their YouTube library to watch a video with friends is a bad trade.
//! Public video data is fetched server-side with our own API key instead.

use crate::{config::GoogleConfig, error::AppError, util};
use serde::{Deserialize, Serialize};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const SCOPES: &str = "openid email profile";

/// Values that must survive the round trip to Google, held server-side in Redis
/// and keyed by the `state` we hand out.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAuth {
    pub pkce_verifier: String,
    pub nonce: String,
    /// Where to send the browser afterwards. Validated against an allowlist
    /// before use — an open redirect here would be a phishing primitive.
    pub return_to: String,
    pub created_at: i64,
}

pub struct AuthorizationRequest {
    pub url: String,
    pub state: String,
    pub state_hash: String,
    pub pending: PendingAuth,
}

/// Build the authorize URL and the state that must be stored alongside it.
pub fn begin(config: &GoogleConfig, return_to: &str) -> AuthorizationRequest {
    let state = util::random_token(24);
    let nonce = util::random_token(16);
    let pkce_verifier = util::random_token(48);
    let challenge = pkce_challenge(&pkce_verifier);

    let url = format!(
        "{AUTH_ENDPOINT}?response_type=code\
         &client_id={client_id}\
         &redirect_uri={redirect_uri}\
         &scope={scope}\
         &state={state}\
         &nonce={nonce}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &access_type=online\
         &prompt=select_account",
        client_id = urlencoding::encode(&config.client_id),
        redirect_uri = urlencoding::encode(&config.redirect_uri),
        scope = urlencoding::encode(SCOPES),
        state = urlencoding::encode(&state),
        nonce = urlencoding::encode(&nonce),
        challenge = urlencoding::encode(&challenge),
    );

    AuthorizationRequest {
        state_hash: util::sha256_hex(&state),
        url,
        state,
        pending: PendingAuth {
            pkce_verifier,
            nonce,
            return_to: return_to.to_owned(),
            created_at: util::now_ms(),
        },
    }
}

/// S256 PKCE challenge: base64url(sha256(verifier)), unpadded.
fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    id_token: String,
}

/// Claims we consume from Google's ID token.
#[derive(Debug, Clone, Deserialize)]
pub struct GoogleIdentity {
    /// Stable per-account identifier. The only safe join key.
    pub sub: String,
    pub email: Option<String>,
    #[serde(default)]
    pub email_verified: bool,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub nonce: Option<String>,
    pub aud: String,
    pub iss: String,
    pub exp: i64,
}

/// Exchange the authorization code and return the verified identity.
pub async fn exchange_code(
    http: &reqwest::Client,
    config: &GoogleConfig,
    code: &str,
    pending: &PendingAuth,
) -> Result<GoogleIdentity, AppError> {
    let response = http
        .post(TOKEN_ENDPOINT)
        .form(&[
            ("code", code),
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
            ("redirect_uri", config.redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", pending.pkce_verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| AppError::Upstream(format!("google token request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        // Google's error body can name the client id; keep it out of the response.
        let body = response.text().await.unwrap_or_default();
        tracing::warn!(%status, %body, "google rejected the code exchange");
        return Err(AppError::Upstream("google rejected the sign-in".into()));
    }

    let tokens: TokenResponse = response
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("malformed google token response: {e}")))?;

    let identity = decode_id_token(&tokens.id_token)?;
    verify_identity(&identity, config, &pending.nonce)?;
    Ok(identity)
}

/// Decode the ID token payload **without** verifying its signature.
///
/// This is sound here, and only here: the token was just delivered to us
/// directly by Google's token endpoint over an authenticated, TLS-protected
/// channel in response to our own client-secret-bearing request. OIDC Core
/// §3.1.3.7 explicitly permits skipping signature validation in exactly this
/// case. We still validate every claim below.
///
/// An ID token arriving by any *other* route (an implicit flow, or one posted
/// by a client) would have to be signature-verified against Google's JWKS. This
/// codebase has no such route, by design.
fn decode_id_token(id_token: &str) -> Result<GoogleIdentity, AppError> {
    use base64::Engine as _;

    let payload_b64 = id_token
        .split('.')
        .nth(1)
        .ok_or_else(|| AppError::Upstream("google id_token is not a JWT".into()))?;

    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| AppError::Upstream("google id_token payload is not base64url".into()))?;

    serde_json::from_slice(&payload)
        .map_err(|e| AppError::Upstream(format!("google id_token claims unreadable: {e}")))
}

fn verify_identity(
    identity: &GoogleIdentity,
    config: &GoogleConfig,
    expected_nonce: &str,
) -> Result<(), AppError> {
    if identity.iss != "https://accounts.google.com" && identity.iss != "accounts.google.com" {
        return Err(AppError::Upstream("unexpected id_token issuer".into()));
    }

    // The audience must be *our* client id. Without this check, a token minted
    // for any other Google app would be accepted here.
    if identity.aud != config.client_id {
        return Err(AppError::Upstream("id_token was not issued for this app".into()));
    }

    if identity.exp <= chrono::Utc::now().timestamp() {
        return Err(AppError::Upstream("id_token has expired".into()));
    }

    // Binds the token to the authorize request we started, defeating replay.
    match identity.nonce.as_deref() {
        Some(nonce) if nonce == expected_nonce => {}
        _ => return Err(AppError::Upstream("id_token nonce did not match".into())),
    }

    Ok(())
}

/// Pick a display name, degrading gracefully. Google always sends `sub`, but
/// `name` is absent on some accounts.
pub fn display_name_for(identity: &GoogleIdentity) -> String {
    identity
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(util::normalize_display_name)
        .or_else(|| {
            identity
                .email
                .as_deref()
                .and_then(|e| e.split('@').next())
                .map(util::normalize_display_name)
        })
        .filter(|n| n.chars().count() >= 2)
        .unwrap_or_else(|| "Viewer".to_string())
}

/// Only ever redirect to our own site. An attacker-supplied `return_to` that we
/// followed blindly would turn the login endpoint into an open redirect.
pub fn sanitize_return_to(candidate: &str, web_origin: &str) -> String {
    let is_safe_relative = candidate.starts_with('/')
        && !candidate.starts_with("//")
        && !candidate.contains('\\');

    if is_safe_relative {
        format!("{}{}", web_origin.trim_end_matches('/'), candidate)
    } else if candidate.starts_with(web_origin) {
        candidate.to_owned()
    } else {
        web_origin.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> GoogleConfig {
        GoogleConfig {
            client_id: "client-123.apps.googleusercontent.com".into(),
            client_secret: "secret".into(),
            redirect_uri: "https://app.example.com/api/auth/google/callback".into(),
        }
    }

    fn identity(nonce: &str) -> GoogleIdentity {
        GoogleIdentity {
            sub: "1234567890".into(),
            email: Some("anas@example.com".into()),
            email_verified: true,
            name: Some("Anas Mohamed".into()),
            picture: None,
            nonce: Some(nonce.into()),
            aud: config().client_id,
            iss: "https://accounts.google.com".into(),
            exp: chrono::Utc::now().timestamp() + 600,
        }
    }

    #[test]
    fn pkce_challenge_matches_the_rfc7636_test_vector() {
        // RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorize_url_carries_pkce_and_minimum_scopes() {
        let request = begin(&config(), "/rooms/abc");
        assert!(request.url.contains("code_challenge_method=S256"));
        assert!(request.url.contains("response_type=code"));
        assert!(request.url.contains("openid%20email%20profile"));
        // The scope we promised never to ask for.
        assert!(!request.url.contains("youtube"));
        // The verifier must never appear in the URL — only its challenge.
        assert!(!request.url.contains(&request.pending.pkce_verifier));
    }

    #[test]
    fn state_is_stored_only_as_a_hash() {
        let request = begin(&config(), "/");
        assert_eq!(request.state_hash, util::sha256_hex(&request.state));
        assert_ne!(request.state_hash, request.state);
    }

    #[test]
    fn accepts_a_wellformed_identity() {
        assert!(verify_identity(&identity("n1"), &config(), "n1").is_ok());
    }

    #[test]
    fn rejects_a_token_minted_for_another_app() {
        let mut id = identity("n1");
        id.aud = "someone-else.apps.googleusercontent.com".into();
        assert!(verify_identity(&id, &config(), "n1").is_err());
    }

    #[test]
    fn rejects_a_replayed_nonce() {
        assert!(verify_identity(&identity("n1"), &config(), "n2").is_err());
        let mut missing = identity("n1");
        missing.nonce = None;
        assert!(verify_identity(&missing, &config(), "n1").is_err());
    }

    #[test]
    fn rejects_a_foreign_issuer() {
        let mut id = identity("n1");
        id.iss = "https://evil.example.com".into();
        assert!(verify_identity(&id, &config(), "n1").is_err());
    }

    #[test]
    fn rejects_an_expired_token() {
        let mut id = identity("n1");
        id.exp = chrono::Utc::now().timestamp() - 1;
        assert!(verify_identity(&id, &config(), "n1").is_err());
    }

    #[test]
    fn display_name_falls_back_through_email_then_placeholder() {
        let mut id = identity("n");
        assert_eq!(display_name_for(&id), "Anas Mohamed");

        id.name = None;
        assert_eq!(display_name_for(&id), "anas");

        id.email = None;
        assert_eq!(display_name_for(&id), "Viewer");

        id.name = Some("  ".into());
        assert_eq!(display_name_for(&id), "Viewer");
    }

    #[test]
    fn return_to_cannot_be_used_as_an_open_redirect() {
        let origin = "https://app.example.com";
        assert_eq!(
            sanitize_return_to("/rooms/abc", origin),
            "https://app.example.com/rooms/abc"
        );
        // Protocol-relative and absolute foreign URLs both collapse to the origin.
        assert_eq!(sanitize_return_to("//evil.com", origin), origin);
        assert_eq!(sanitize_return_to("https://evil.com/x", origin), origin);
        assert_eq!(sanitize_return_to("/\\evil.com", origin), origin);
        assert_eq!(
            sanitize_return_to("https://app.example.com/rooms/x", origin),
            "https://app.example.com/rooms/x"
        );
    }
}
