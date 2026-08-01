//! Environment-driven configuration.
//!
//! Everything is read once at boot and validated eagerly, so a misconfigured
//! deployment fails on startup with a precise message rather than at 3am on the
//! first request that happens to need the missing value.

use std::{env, fmt, num::ParseIntError, str::FromStr, time::Duration};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing required environment variable `{0}`")]
    Missing(&'static str),
    #[error("environment variable `{key}` is invalid: {reason}")]
    Invalid { key: &'static str, reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    Development,
    Production,
}

impl Environment {
    pub fn is_production(self) -> bool {
        matches!(self, Self::Production)
    }
}

impl FromStr for Environment {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "dev" | "development" | "local" => Ok(Self::Development),
            "prod" | "production" => Ok(Self::Production),
            other => Err(format!("expected development|production, got `{other}`")),
        }
    }
}

impl fmt::Display for Environment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Development => f.write_str("development"),
            Self::Production => f.write_str("production"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub environment: Environment,
    pub bind_addr: String,
    pub public_url: String,
    pub web_origin: String,
    /// Read the caller's IP from `CF-Connecting-IP` / `X-Forwarded-For`.
    ///
    /// Required behind a reverse proxy, or every user shares one rate-limit
    /// bucket. Dangerous without one: a directly-reachable origin that believes
    /// these headers lets any client forge an identity.
    pub trust_proxy_headers: bool,

    pub database: DatabaseConfig,
    pub redis: RedisConfig,
    pub auth: AuthConfig,
    pub google: Option<GoogleConfig>,
    pub youtube: YouTubeConfig,
    pub realtime: RealtimeConfig,
    pub voice: VoiceConfig,
    pub limits: LimitsConfig,
}

#[derive(Debug, Clone)]
pub struct DatabaseConfig {
    pub url: String,
    pub max_connections: u32,
    pub min_connections: u32,
    pub acquire_timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct RedisConfig {
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// Ed25519 private key in PKCS#8 PEM. Generate with `scripts/gen-keys.sh`.
    pub jwt_private_pem: String,
    pub jwt_public_pem: String,
    pub access_token_ttl: Duration,
    pub refresh_token_ttl: Duration,
    /// Ticket presented as the first WebSocket frame; deliberately very short-lived.
    pub ws_ticket_ttl: Duration,
    pub cookie_domain: Option<String>,
    /// Only ever false in local development over plain http.
    pub cookie_secure: bool,
}

#[derive(Debug, Clone)]
pub struct GoogleConfig {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
}

#[derive(Debug, Clone)]
pub struct YouTubeConfig {
    /// Server-side key for the Data API. Absent means search degrades to
    /// direct-URL paste only — the room still works.
    pub api_key: Option<String>,
    pub metadata_cache_ttl: Duration,
}

#[derive(Debug, Clone)]
pub struct RealtimeConfig {
    pub heartbeat_interval: Duration,
    pub client_timeout: Duration,
    /// Deadline for the `authenticate` frame after the socket opens.
    pub handshake_timeout: Duration,
    /// Outbound queue depth per connection before we drop the slow client.
    pub send_buffer: usize,
    /// How long a node's claim on a room survives without renewal.
    pub room_lease_ttl: Duration,
    pub room_lease_renew: Duration,
    /// How long a room may sit empty before it is closed. This is what makes
    /// "delete the room when everyone leaves" survive a page refresh.
    pub empty_room_grace: Duration,
    /// How often the sweep looks for rooms past that grace period.
    pub empty_room_sweep: Duration,
    /// How long the room waits for a departed host to come back before handing
    /// the room to someone else. A refresh closes and reopens the socket, so
    /// without this every host who reloaded the page lost their room.
    pub host_grace: Duration,
}

#[derive(Debug, Clone)]
pub struct VoiceConfig {
    pub mesh_max_peers: usize,
    pub stun_urls: Vec<String>,
    pub turn_url: Option<String>,
    pub turn_username: Option<String>,
    pub turn_credential: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LimitsConfig {
    pub chat_per_minute: u32,
    pub queue_adds_per_minute: u32,
    pub sync_intents_per_minute: u32,
    pub reactions_per_minute: u32,
    pub rooms_per_hour: u32,
    pub http_per_minute: u32,
    /// Playlist imports are metered separately and far more tightly: one
    /// request makes the server fetch a third-party URL and can append
    /// hundreds of rows, so it is nothing like a single queue add.
    pub imports_per_minute: u32,
    /// Hard ceiling on a fetched playlist body. Public IPTV lists are a few
    /// hundred kilobytes; anything far past that is not a playlist.
    pub playlist_max_bytes: usize,
    pub playlist_timeout: std::time::Duration,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let environment: Environment = parse_opt("APP_ENV")?.unwrap_or(Environment::Development);
        let is_prod = environment.is_production();

        let public_url = optional("PUBLIC_URL").unwrap_or_else(|| "http://localhost:8080".into());
        let web_origin = optional("WEB_ORIGIN").unwrap_or_else(|| "http://localhost:3000".into());

        let google = match (
            optional("GOOGLE_CLIENT_ID"),
            optional("GOOGLE_CLIENT_SECRET"),
        ) {
            (Some(client_id), Some(client_secret)) => Some(GoogleConfig {
                client_id,
                client_secret,
                redirect_uri: optional("GOOGLE_REDIRECT_URI")
                    .unwrap_or_else(|| format!("{public_url}/api/auth/google/callback")),
            }),
            // Guest mode alone is a complete product; Google is additive.
            _ => None,
        };

        let config = Self {
            environment,
            bind_addr: optional("BIND_ADDR").unwrap_or_else(|| "0.0.0.0:8080".into()),
            public_url,
            web_origin,
            trust_proxy_headers: parse_opt("TRUST_PROXY_HEADERS")?.unwrap_or(false),

            database: DatabaseConfig {
                url: required("DATABASE_URL")?,
                max_connections: parse_opt("DATABASE_MAX_CONNECTIONS")?.unwrap_or(20),
                min_connections: parse_opt("DATABASE_MIN_CONNECTIONS")?.unwrap_or(2),
                acquire_timeout: secs(parse_opt("DATABASE_ACQUIRE_TIMEOUT_SECS")?.unwrap_or(10)),
            },

            redis: RedisConfig {
                url: required("REDIS_URL")?,
            },

            auth: AuthConfig {
                jwt_private_pem: read_pem(
                    "JWT_PRIVATE_KEY",
                    "JWT_PRIVATE_KEY_FILE",
                    "PRIVATE KEY",
                )?,
                jwt_public_pem: read_pem("JWT_PUBLIC_KEY", "JWT_PUBLIC_KEY_FILE", "PUBLIC KEY")?,
                access_token_ttl: secs(parse_opt("ACCESS_TOKEN_TTL_SECS")?.unwrap_or(900)),
                refresh_token_ttl: secs(
                    parse_opt("REFRESH_TOKEN_TTL_SECS")?.unwrap_or(60 * 60 * 24 * 30),
                ),
                ws_ticket_ttl: secs(parse_opt("WS_TICKET_TTL_SECS")?.unwrap_or(30)),
                cookie_domain: optional("COOKIE_DOMAIN"),
                cookie_secure: parse_opt("COOKIE_SECURE")?.unwrap_or(is_prod),
            },

            google,

            youtube: YouTubeConfig {
                api_key: optional("YOUTUBE_API_KEY"),
                metadata_cache_ttl: secs(
                    parse_opt("YOUTUBE_CACHE_TTL_SECS")?.unwrap_or(60 * 60 * 12),
                ),
            },

            realtime: RealtimeConfig {
                heartbeat_interval: secs(parse_opt("WS_HEARTBEAT_SECS")?.unwrap_or(15)),
                client_timeout: secs(parse_opt("WS_CLIENT_TIMEOUT_SECS")?.unwrap_or(30)),
                handshake_timeout: secs(parse_opt("WS_HANDSHAKE_TIMEOUT_SECS")?.unwrap_or(5)),
                send_buffer: parse_opt("WS_SEND_BUFFER")?.unwrap_or(256),
                host_grace: secs(parse_opt("HOST_GRACE_SECS")?.unwrap_or(25)),
                room_lease_ttl: secs(parse_opt("ROOM_LEASE_TTL_SECS")?.unwrap_or(30)),
                room_lease_renew: secs(parse_opt("ROOM_LEASE_RENEW_SECS")?.unwrap_or(10)),
                empty_room_grace: secs(parse_opt("EMPTY_ROOM_GRACE_SECS")?.unwrap_or(60)),
                empty_room_sweep: secs(parse_opt("EMPTY_ROOM_SWEEP_SECS")?.unwrap_or(30)),
            },

            voice: VoiceConfig {
                mesh_max_peers: parse_opt("VOICE_MESH_MAX_PEERS")?.unwrap_or(8),
                stun_urls: optional("STUN_URLS")
                    .unwrap_or_else(|| "stun:stun.l.google.com:19302".into())
                    .split(',')
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .collect(),
                turn_url: optional("TURN_URL"),
                turn_username: optional("TURN_USERNAME"),
                turn_credential: optional("TURN_CREDENTIAL"),
            },

            limits: LimitsConfig {
                chat_per_minute: parse_opt("RL_CHAT_PER_MIN")?.unwrap_or(30),
                queue_adds_per_minute: parse_opt("RL_QUEUE_PER_MIN")?.unwrap_or(20),
                sync_intents_per_minute: parse_opt("RL_SYNC_PER_MIN")?.unwrap_or(60),
                reactions_per_minute: parse_opt("RL_REACTION_PER_MIN")?.unwrap_or(40),
                rooms_per_hour: parse_opt("RL_ROOMS_PER_HOUR")?.unwrap_or(10),
                http_per_minute: parse_opt("RL_HTTP_PER_MIN")?.unwrap_or(300),
                imports_per_minute: parse_opt("RL_IMPORTS_PER_MIN")?.unwrap_or(3),
                playlist_max_bytes: parse_opt("PLAYLIST_MAX_BYTES")?.unwrap_or(4 * 1024 * 1024),
                playlist_timeout: std::time::Duration::from_secs(
                    parse_opt("PLAYLIST_TIMEOUT_SECS")?.unwrap_or(10),
                ),
            },
        };

        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.environment.is_production() {
            if !self.auth.cookie_secure {
                return Err(ConfigError::Invalid {
                    key: "COOKIE_SECURE",
                    reason: "must be true in production — session cookies would ride plaintext"
                        .into(),
                });
            }
            if !self.trust_proxy_headers {
                // Not fatal: someone may genuinely terminate TLS on the
                // process. But behind a proxy this silently collapses every
                // per-IP limit into one shared bucket, so it must be loud.
                tracing::warn!(
                    "TRUST_PROXY_HEADERS is false in production — if this service sits behind \
                     a reverse proxy, rate limiting is counting the proxy's IP for every user"
                );
            }
            if self.web_origin.starts_with("http://") {
                return Err(ConfigError::Invalid {
                    key: "WEB_ORIGIN",
                    reason: "must be https in production".into(),
                });
            }
        }

        if self.database.min_connections > self.database.max_connections {
            return Err(ConfigError::Invalid {
                key: "DATABASE_MIN_CONNECTIONS",
                reason: "cannot exceed DATABASE_MAX_CONNECTIONS".into(),
            });
        }

        if self.realtime.room_lease_renew >= self.realtime.room_lease_ttl {
            return Err(ConfigError::Invalid {
                key: "ROOM_LEASE_RENEW_SECS",
                reason: "must be well below ROOM_LEASE_TTL_SECS or leases will expire mid-renewal"
                    .into(),
            });
        }

        if self.realtime.client_timeout <= self.realtime.heartbeat_interval {
            return Err(ConfigError::Invalid {
                key: "WS_CLIENT_TIMEOUT_SECS",
                reason: "must exceed WS_HEARTBEAT_SECS or every client is reaped as dead".into(),
            });
        }

        Ok(())
    }

    /// Origins permitted by CORS. The web origin plus, in development, the Vite
    /// dev server on either loopback spelling.
    pub fn allowed_origins(&self) -> Vec<String> {
        let mut origins = vec![self.web_origin.clone()];
        if !self.environment.is_production() {
            origins.push("http://localhost:3000".into());
            origins.push("http://127.0.0.1:3000".into());
        }
        origins.sort();
        origins.dedup();
        origins
    }
}

fn optional(key: &'static str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn required(key: &'static str) -> Result<String, ConfigError> {
    optional(key).ok_or(ConfigError::Missing(key))
}

fn parse_opt<T>(key: &'static str) -> Result<Option<T>, ConfigError>
where
    T: FromStr,
    T::Err: fmt::Display,
{
    match optional(key) {
        None => Ok(None),
        Some(raw) => raw
            .parse::<T>()
            .map(Some)
            .map_err(|e| ConfigError::Invalid {
                key,
                reason: e.to_string(),
            }),
    }
}

/// Secrets may arrive inline or as a path — Docker secrets and Dokploy's
/// env UI disagree about which is idiomatic, so support both.
fn read_pem(
    inline_key: &'static str,
    file_key: &'static str,
    label: &str,
) -> Result<String, ConfigError> {
    if let Some(path) = optional(file_key) {
        return std::fs::read_to_string(&path).map_err(|e| ConfigError::Invalid {
            key: file_key,
            reason: format!("could not read `{path}`: {e}"),
        });
    }
    Ok(normalize_pem(&required(inline_key)?, label))
}

/// Coerce whatever a deployment UI did to the key back into valid PEM.
///
/// Three shapes reach us in practice and all three are the same key:
///   * proper PEM with real newlines
///   * PEM with `\n` escaped, because the field is single-line
///   * the bare base64 body, because someone stripped the armour
///
/// Rejecting the last two would be technically defensible and practically
/// hostile — it is a boot failure whose cause is invisible in the UI that
/// caused it. Anything genuinely malformed still fails later, in the key
/// parser, which gives a better message than we could.
fn normalize_pem(raw: &str, label: &str) -> String {
    let value = raw.trim().replace("\\n", "\n");

    if value.contains("-----BEGIN") {
        return value;
    }

    // Bare base64: strip any stray whitespace and re-wrap at 64 columns.
    let body: String = value.split_whitespace().collect();
    let wrapped = body
        .as_bytes()
        .chunks(64)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("\n");

    format!("-----BEGIN {label}-----\n{wrapped}\n-----END {label}-----\n")
}

const fn secs(v: u64) -> Duration {
    Duration::from_secs(v)
}

impl From<ParseIntError> for ConfigError {
    fn from(e: ParseIntError) -> Self {
        Self::Invalid {
            key: "<numeric>",
            reason: e.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_base64_keys_are_wrapped_into_pem() {
        // Exactly what you get from a deployment UI that stripped the armour.
        let bare = "MCowBQYDK2VwAyEAnAyqj8aKfgE7IJ9dBH5wAcD1NOOeT3Xgv9hBu2Wrzhw=";
        let pem = normalize_pem(bare, "PUBLIC KEY");

        assert!(pem.starts_with("-----BEGIN PUBLIC KEY-----\n"));
        assert!(pem.trim_end().ends_with("-----END PUBLIC KEY-----"));
        assert!(pem.contains(bare));
    }

    #[test]
    fn escaped_newlines_are_restored() {
        let escaped = "-----BEGIN PRIVATE KEY-----\\nMC4CAQ\\n-----END PRIVATE KEY-----";
        let pem = normalize_pem(escaped, "PRIVATE KEY");

        assert!(!pem.contains("\\n"));
        assert_eq!(pem.lines().count(), 3);
    }

    #[test]
    fn wellformed_pem_is_left_alone() {
        let original = "-----BEGIN PRIVATE KEY-----\nMC4CAQ\n-----END PRIVATE KEY-----\n";
        assert_eq!(normalize_pem(original, "PRIVATE KEY"), original.trim());
    }

    #[test]
    fn long_bare_keys_are_wrapped_at_64_columns() {
        // PEM decoders are line-length tolerant, but emitting canonical output
        // keeps the failure surface small if a stricter one is ever used.
        let bare = "A".repeat(200);
        let pem = normalize_pem(&bare, "PRIVATE KEY");

        let body: Vec<&str> = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        assert!(body.iter().all(|line| line.len() <= 64));
        assert_eq!(body.concat(), bare);
    }

    #[test]
    fn environment_parses_common_spellings() {
        assert_eq!("prod".parse::<Environment>().unwrap(), Environment::Production);
        assert_eq!("Development".parse::<Environment>().unwrap(), Environment::Development);
        assert!("staging".parse::<Environment>().is_err());
    }

    fn base_config() -> Config {
        Config {
            environment: Environment::Development,
            bind_addr: "0.0.0.0:8080".into(),
            public_url: "http://localhost:8080".into(),
            web_origin: "http://localhost:3000".into(),
            trust_proxy_headers: false,
            database: DatabaseConfig {
                url: "postgres://localhost/x".into(),
                max_connections: 10,
                min_connections: 1,
                acquire_timeout: secs(5),
            },
            redis: RedisConfig { url: "redis://localhost".into() },
            auth: AuthConfig {
                jwt_private_pem: "x".into(),
                jwt_public_pem: "y".into(),
                access_token_ttl: secs(900),
                refresh_token_ttl: secs(1000),
                ws_ticket_ttl: secs(30),
                cookie_domain: None,
                cookie_secure: false,
            },
            google: None,
            youtube: YouTubeConfig { api_key: None, metadata_cache_ttl: secs(60) },
            realtime: RealtimeConfig {
                heartbeat_interval: secs(15),
                client_timeout: secs(30),
                handshake_timeout: secs(5),
                send_buffer: 256,
                room_lease_ttl: secs(30),
                room_lease_renew: secs(10),
                empty_room_grace: secs(60),
                empty_room_sweep: secs(30),
                host_grace: secs(25),
            },
            voice: VoiceConfig {
                mesh_max_peers: 8,
                stun_urls: vec![],
                turn_url: None,
                turn_username: None,
                turn_credential: None,
            },
            limits: LimitsConfig {
                chat_per_minute: 30,
                queue_adds_per_minute: 20,
                sync_intents_per_minute: 60,
                reactions_per_minute: 40,
                rooms_per_hour: 10,
                http_per_minute: 300,
                imports_per_minute: 3,
                playlist_max_bytes: 4 * 1024 * 1024,
                playlist_timeout: std::time::Duration::from_secs(10),
            },
        }
    }

    #[test]
    fn rejects_lease_renewal_at_or_past_ttl() {
        let mut cfg = base_config();
        cfg.realtime.room_lease_renew = cfg.realtime.room_lease_ttl;
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn rejects_client_timeout_below_heartbeat() {
        let mut cfg = base_config();
        cfg.realtime.client_timeout = secs(10);
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn rejects_insecure_cookies_in_production() {
        let mut cfg = base_config();
        cfg.environment = Environment::Production;
        cfg.web_origin = "https://example.com".into();
        cfg.auth.cookie_secure = false;
        assert!(cfg.validate().is_err());
    }
}
