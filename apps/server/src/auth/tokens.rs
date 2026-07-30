//! Token issuing and verification.
//!
//! Split-token model (ADR 0007): a short-lived, self-contained Ed25519 access
//! token the client holds in memory, and an opaque, rotating refresh token in
//! an httpOnly cookie whose hash is the only copy we store.

use crate::{config::AuthConfig, db::users::User, util};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("token is malformed or its signature does not verify")]
    Invalid,
    #[error("token has expired")]
    Expired,
    #[error("key material could not be loaded: {0}")]
    Key(String),
}

/// Claims carried by the access token.
///
/// Everything here is presentation data plus identity. Deliberately absent:
/// room permissions. Those are re-evaluated server-side on every action, so a
/// token minted before a demotion cannot carry stale authority
/// (ADR 0007 § Authorisation).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessClaims {
    /// Subject — the user id.
    pub sub: Uuid,
    /// `google` or `guest`.
    pub kind: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub iat: i64,
    pub exp: i64,
    /// Token id, so a specific access token can be traced in logs.
    pub jti: Uuid,
}

impl AccessClaims {
    pub fn is_guest(&self) -> bool {
        self.kind == "guest"
    }
}

/// Parsed key material. Built once at startup — parsing PEM per request would
/// be a needless cost on the hottest middleware in the service.
pub struct TokenKeys {
    encoding: EncodingKey,
    decoding: DecodingKey,
    header: Header,
    validation: Validation,
}

impl std::fmt::Debug for TokenKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print key material, not even accidentally through a derived Debug.
        f.debug_struct("TokenKeys").finish_non_exhaustive()
    }
}

impl TokenKeys {
    pub fn from_config(config: &AuthConfig) -> Result<Self, TokenError> {
        let encoding = EncodingKey::from_ed_pem(config.jwt_private_pem.as_bytes())
            .map_err(|e| TokenError::Key(format!("private key: {e}")))?;
        let decoding = DecodingKey::from_ed_pem(config.jwt_public_pem.as_bytes())
            .map_err(|e| TokenError::Key(format!("public key: {e}")))?;

        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.validate_exp = true;
        // No audience or issuer: this service both mints and consumes, and a
        // constant we always match against adds no security.
        validation.required_spec_claims.clear();
        validation.required_spec_claims.insert("exp".to_string());
        // Tolerate a small amount of clock skew between nodes.
        validation.leeway = 5;

        Ok(Self {
            encoding,
            decoding,
            header: Header::new(Algorithm::EdDSA),
            validation,
        })
    }

    pub fn issue_access_token(
        &self,
        user: &User,
        ttl: std::time::Duration,
    ) -> Result<(String, AccessClaims), TokenError> {
        let now = chrono::Utc::now().timestamp();
        let claims = AccessClaims {
            sub: user.id,
            kind: user.kind.clone(),
            name: user.display_name.clone(),
            avatar: user.avatar_url.clone(),
            iat: now,
            exp: now + ttl.as_secs() as i64,
            jti: Uuid::now_v7(),
        };

        let token = jsonwebtoken::encode(&self.header, &claims, &self.encoding)
            .map_err(|_| TokenError::Invalid)?;

        Ok((token, claims))
    }

    pub fn verify_access_token(&self, token: &str) -> Result<AccessClaims, TokenError> {
        use jsonwebtoken::errors::ErrorKind;

        jsonwebtoken::decode::<AccessClaims>(token, &self.decoding, &self.validation)
            .map(|data| data.claims)
            .map_err(|error| match error.kind() {
                ErrorKind::ExpiredSignature => TokenError::Expired,
                _ => TokenError::Invalid,
            })
    }
}

/// An opaque refresh token and the hash we persist.
///
/// The plaintext is returned exactly once, to be written into the cookie. Only
/// the hash is stored, so a database dump does not yield usable sessions.
pub struct RefreshTokenPair {
    pub plaintext: String,
    pub hash: String,
}

pub fn generate_refresh_token() -> RefreshTokenPair {
    let plaintext = util::random_token(32);
    let hash = util::sha256_hex(&plaintext);
    RefreshTokenPair { plaintext, hash }
}

/// Short-lived, single-use credential for opening a WebSocket.
///
/// A WebSocket cannot carry an `Authorization` header, and putting a bearer
/// token in the query string writes it to every access log between the client
/// and us. A ticket is issued over authenticated HTTP, redeemed once, and
/// expires in seconds (ADR 0007).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsTicket {
    pub user_id: Uuid,
    pub room_id: Uuid,
    pub issued_at: i64,
}

pub struct IssuedTicket {
    pub plaintext: String,
    pub hash: String,
    pub payload: WsTicket,
}

pub fn generate_ws_ticket(user_id: Uuid, room_id: Uuid) -> IssuedTicket {
    let plaintext = util::random_token(24);
    IssuedTicket {
        hash: util::sha256_hex(&plaintext),
        plaintext,
        payload: WsTicket {
            user_id,
            room_id,
            issued_at: util::now_ms(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuthConfig;
    use chrono::Utc;
    use std::time::Duration;

    // Throwaway Ed25519 keypair, generated for these tests only and never used
    // by any environment:
    //   openssl genpkey -algorithm ed25519 -out k.pem
    //   openssl pkey -in k.pem -pubout -out k.pub.pem
    const PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
        MC4CAQAwBQYDK2VwBCIEICfLqu/APO1gUg6Kg679Z4ufHyLVKxZoZVRbWfbmoAGf\n\
        -----END PRIVATE KEY-----\n";
    const PUBLIC_PEM: &str = "-----BEGIN PUBLIC KEY-----\n\
        MCowBQYDK2VwAyEA06OTcbFRXpYtNVxJzkzLF+nCG7ZFQglHpP48e0w+CO0=\n\
        -----END PUBLIC KEY-----\n";

    fn keys() -> TokenKeys {
        TokenKeys::from_config(&AuthConfig {
            jwt_private_pem: PRIVATE_PEM.into(),
            jwt_public_pem: PUBLIC_PEM.into(),
            access_token_ttl: Duration::from_secs(900),
            refresh_token_ttl: Duration::from_secs(3600),
            ws_ticket_ttl: Duration::from_secs(30),
            cookie_domain: None,
            cookie_secure: false,
        })
        .expect("embedded test keypair must load")
    }

    fn user() -> User {
        User {
            id: Uuid::now_v7(),
            kind: "guest".into(),
            google_sub: None,
            email: None,
            display_name: "Anas Mohamed".into(),
            avatar_url: None,
            created_at: Utc::now(),
            last_seen_at: Utc::now(),
        }
    }

    #[test]
    fn round_trips_claims_when_keys_load() {
        let keys = keys();
        let user = user();
        let (token, issued) = keys
            .issue_access_token(&user, Duration::from_secs(900))
            .expect("issue");

        let verified = keys.verify_access_token(&token).expect("verify");
        assert_eq!(verified.sub, user.id);
        assert_eq!(verified.name, "Anas Mohamed");
        assert!(verified.is_guest());
        assert_eq!(verified.jti, issued.jti);
    }

    #[test]
    fn rejects_a_tampered_payload() {
        let keys = keys();
        let (token, _) = keys
            .issue_access_token(&user(), Duration::from_secs(900))
            .expect("issue");

        // Flip a character in the payload segment.
        let mut parts: Vec<&str> = token.split('.').collect();
        let payload = parts[1].to_string();
        let mutated = format!("{}A", &payload[..payload.len() - 1]);
        parts[1] = &mutated;
        let tampered = parts.join(".");

        assert!(matches!(
            keys.verify_access_token(&tampered),
            Err(TokenError::Invalid)
        ));
    }

    #[test]
    fn rejects_garbage() {
        let keys = keys();
        assert!(keys.verify_access_token("not-a-token").is_err());
        assert!(keys.verify_access_token("").is_err());
    }

    #[test]
    fn refresh_tokens_are_unique_and_only_the_hash_is_derivable() {
        let a = generate_refresh_token();
        let b = generate_refresh_token();
        assert_ne!(a.plaintext, b.plaintext);
        assert_ne!(a.hash, b.hash);
        assert_eq!(a.hash, util::sha256_hex(&a.plaintext));
        assert_ne!(a.hash, a.plaintext);
    }

    #[test]
    fn ws_tickets_bind_a_user_to_one_room() {
        let user_id = Uuid::now_v7();
        let room_id = Uuid::now_v7();
        let ticket = generate_ws_ticket(user_id, room_id);

        assert_eq!(ticket.payload.user_id, user_id);
        assert_eq!(ticket.payload.room_id, room_id);
        assert_eq!(ticket.hash, util::sha256_hex(&ticket.plaintext));
    }

    #[test]
    fn keys_debug_impl_does_not_leak_material() {
        let keys = keys();
        let rendered = format!("{keys:?}");
        assert!(!rendered.contains("BEGIN"));
        assert!(!rendered.contains("MC4CAQ"));
    }
}
