//! Server-side fetching of user-supplied URLs.
//!
//! Playlist import takes a URL from a room member and asks *our* server to
//! retrieve it. That is a server-side request forgery primitive by
//! construction: without a guard it reaches the cloud metadata endpoint, the
//! Postgres and Redis containers on the internal network, and anything else
//! reachable from the pod but not from the internet.
//!
//! The defence is three layers, and all three are needed:
//!
//!   1. Only `http`/`https`, enforced when the URL is classified.
//!   2. Resolve the hostname ourselves and reject any address that is not
//!      publicly routable.
//!   3. **Pin** the connection to the address we validated, and follow
//!      redirects manually so every hop repeats the check.
//!
//! Layer 3 is what closes the DNS-rebinding hole. Validating a hostname and
//! then handing that hostname to the HTTP client lets the attacker's resolver
//! answer differently the second time; pinning means the socket goes to the
//! address we actually approved.

use crate::error::AppError;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

/// Redirect chains longer than this are a loop or an attempt to exhaust the
/// guard, not a real resource.
const MAX_REDIRECTS: usize = 4;

#[derive(Debug)]
pub struct Fetched {
    /// Where the body actually came from, after redirects. Relative playlist
    /// entries resolve against this, not the URL originally submitted.
    pub final_url: String,
    pub body: String,
}

/// A live upstream response, still streaming.
pub struct Opened {
    /// Where the body actually came from, after redirects. Segment URLs inside
    /// a manifest resolve against this, not the URL originally submitted.
    pub final_url: String,
    pub content_type: Option<String>,
    pub response: reqwest::Response,
}

/// Open a user-supplied URL for streaming, under the same guard as `fetch_text`.
///
/// Separate from `fetch_text` because the relay must not buffer: a video
/// segment is handed to the client as it arrives, and a live channel never
/// ends. Everything about how the URL is validated is identical — the SSRF
/// guard, the pinned address and the hop-by-hop redirect handling are the part
/// that matters, and neither caller may skip it.
pub async fn open_stream(url: &str, timeout: Duration) -> Result<Opened, AppError> {
    let mut current = url.to_string();

    for _ in 0..=MAX_REDIRECTS {
        let (target, client) = prepare(&current, timeout).await?;

        let response = client.get(target.clone()).send().await.map_err(|error| {
            tracing::debug!(?error, "stream fetch failed");
            AppError::BadRequest("Could not reach that stream.".into())
        })?;

        if response.status().is_redirection() {
            current = next_hop(&target, &response)?;
            continue;
        }

        if !response.status().is_success() {
            return Err(AppError::BadRequest(format!(
                "That stream answered with {}.",
                response.status().as_u16()
            )));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);

        return Ok(Opened {
            final_url: target.to_string(),
            content_type,
            response,
        });
    }

    Err(AppError::BadRequest(
        "That stream redirected too many times.".into(),
    ))
}

/// Validate a URL and build a client pinned to the address we approved.
async fn prepare(
    url: &str,
    timeout: Duration,
) -> Result<(reqwest::Url, reqwest::Client), AppError> {
    let target = reqwest::Url::parse(url)
        .map_err(|_| AppError::BadRequest("That is not a valid URL.".into()))?;

    match target.scheme() {
        "http" | "https" => {}
        _ => {
            return Err(AppError::BadRequest(
                "Only http and https URLs can be fetched.".into(),
            ));
        }
    }

    let host = target
        .host_str()
        .ok_or_else(|| AppError::BadRequest("That URL has no host.".into()))?
        .to_string();
    let port = target
        .port_or_known_default()
        .ok_or_else(|| AppError::BadRequest("That URL has no port.".into()))?;

    let address = resolve_public(&host, port).await?;

    let client = reqwest::Client::builder()
        .resolve(&host, address)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        // Some CDNs serve a different rendition — or refuse outright — to a
        // client that does not look like a browser.
        .user_agent("Mozilla/5.0 (compatible; playercn/0.1)")
        .build()
        .map_err(|error| {
            tracing::error!(?error, "failed to build fetch client");
            AppError::Internal(anyhow::anyhow!("http client"))
        })?;

    Ok((target, client))
}

/// Resolve a redirect's `Location` against the URL it came from.
fn next_hop(target: &reqwest::Url, response: &reqwest::Response) -> Result<String, AppError> {
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::BadRequest("That URL redirected without a destination.".into()))?;

    // Relative redirects are legal and common.
    Ok(target
        .join(location)
        .map_err(|_| AppError::BadRequest("That URL redirected somewhere invalid.".into()))?
        .to_string())
}

/// Retrieve a text document from a user-supplied URL.
pub async fn fetch_text(
    url: &str,
    max_bytes: usize,
    timeout: Duration,
) -> Result<Fetched, AppError> {
    let mut current = url.to_string();

    for _ in 0..=MAX_REDIRECTS {
        let target = reqwest::Url::parse(&current)
            .map_err(|_| AppError::BadRequest("That is not a valid URL.".into()))?;

        match target.scheme() {
            "http" | "https" => {}
            _ => {
                return Err(AppError::BadRequest(
                    "Only http and https URLs can be imported.".into(),
                ));
            }
        }

        let host = target
            .host_str()
            .ok_or_else(|| AppError::BadRequest("That URL has no host.".into()))?
            .to_string();
        let port = target
            .port_or_known_default()
            .ok_or_else(|| AppError::BadRequest("That URL has no port.".into()))?;

        let address = resolve_public(&host, port).await?;

        // Pinning the resolved address is what makes the check above binding.
        // Redirects are disabled so each hop re-enters this loop and is
        // validated on its own terms rather than followed blind.
        let client = reqwest::Client::builder()
            .resolve(&host, address)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .user_agent("playercn/0.1 (+playlist-import)")
            .build()
            .map_err(|error| {
                tracing::error!(?error, "failed to build import client");
                AppError::Internal(anyhow::anyhow!("http client"))
            })?;

        let response = client.get(target.clone()).send().await.map_err(|error| {
            tracing::debug!(?error, %host, "playlist fetch failed");
            AppError::BadRequest("Could not reach that URL.".into())
        })?;

        let status = response.status();

        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    AppError::BadRequest("That URL redirected without a destination.".into())
                })?;

            // Relative redirects are legal and common.
            current = target
                .join(location)
                .map_err(|_| AppError::BadRequest("That URL redirected somewhere invalid.".into()))?
                .to_string();
            continue;
        }

        if !status.is_success() {
            return Err(AppError::BadRequest(format!(
                "That URL answered with {}.",
                status.as_u16()
            )));
        }

        // Trust the advertised length only to fail early; the streaming cap
        // below is what actually bounds memory, because Content-Length is
        // attacker-controlled and may be absent or a lie.
        if let Some(length) = response.content_length()
            && length > max_bytes as u64
        {
            return Err(AppError::BadRequest("That playlist is too large.".into()));
        }

        let body = read_capped(response, max_bytes).await?;

        return Ok(Fetched {
            final_url: target.to_string(),
            body,
        });
    }

    Err(AppError::BadRequest(
        "That URL redirected too many times.".into(),
    ))
}

/// Accumulate the body, aborting as soon as it exceeds the cap.
async fn read_capped(mut response: reqwest::Response, max_bytes: usize) -> Result<String, AppError> {
    let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);

    while let Some(chunk) = response.chunk().await.map_err(|error| {
        tracing::debug!(?error, "playlist body read failed");
        AppError::BadRequest("That URL stopped responding mid-download.".into())
    })? {
        if buffer.len() + chunk.len() > max_bytes {
            return Err(AppError::BadRequest("That playlist is too large.".into()));
        }
        buffer.extend_from_slice(&chunk);
    }

    // Playlists are text but are routinely served with a wrong or missing
    // charset, so decode lossily rather than rejecting an otherwise usable
    // list over one bad byte in a channel name.
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Resolve a hostname and return the first publicly routable address.
pub(crate) async fn resolve_public(host: &str, port: u16) -> Result<SocketAddr, AppError> {
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| {
            tracing::debug!(?error, %host, "playlist host did not resolve");
            AppError::BadRequest("That host could not be resolved.".into())
        })?
        .collect();

    if addresses.is_empty() {
        return Err(AppError::BadRequest("That host could not be resolved.".into()));
    }

    // Every resolved address must be public, not merely the one we pick. A host
    // answering with one public and one private address would otherwise be a
    // coin flip, and the attacker gets to flip it as often as they like.
    if let Some(blocked) = addresses.iter().find(|addr| !is_public(addr.ip())) {
        tracing::warn!(%host, ip = %blocked.ip(), "blocked import of a non-public address");
        return Err(AppError::BadRequest(
            "That URL points inside a private network.".into(),
        ));
    }

    Ok(addresses[0])
}

/// Is this address routable on the public internet?
///
/// `IpAddr::is_global` is still unstable, so the ranges are spelled out. The
/// list is deny-by-default in spirit: anything in a special-purpose registry
/// is rejected, because none of it is a legitimate playlist host.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                // 0.0.0.0/8 — "this network"
                || a == 0
                // 100.64.0.0/10 — carrier-grade NAT
                || (a == 100 && (64..128).contains(&b))
                // 192.0.0.0/24 — IETF protocol assignments
                || (a == 192 && b == 0 && c == 0)
                // 198.18.0.0/15 — benchmarking
                || (a == 198 && (b == 18 || b == 19))
                // 240.0.0.0/4 — reserved
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            // An IPv4 address wearing an IPv6 costume is the oldest way past a
            // naive check, so unwrap both mappings and judge the real address.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(mapped));
            }
            if let Some(compat) = v6.to_ipv4() {
                return is_public(IpAddr::V4(compat));
            }

            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fc00::/7 — unique local
                || (first & 0xFE00) == 0xFC00
                // fe80::/10 — link local
                || (first & 0xFFC0) == 0xFE80
                // 2001:db8::/32 — documentation
                || (first == 0x2001 && v6.segments()[1] == 0x0DB8))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn v4(s: &str) -> IpAddr {
        IpAddr::V4(s.parse::<Ipv4Addr>().unwrap())
    }
    fn v6(s: &str) -> IpAddr {
        IpAddr::V6(s.parse::<Ipv6Addr>().unwrap())
    }

    #[test]
    fn ordinary_public_addresses_are_allowed() {
        for ip in ["1.1.1.1", "8.8.8.8", "93.184.216.34", "203.0.113.1"] {
            // 203.0.113.0/24 is TEST-NET-3, i.e. documentation — excluded below.
            if ip == "203.0.113.1" {
                continue;
            }
            assert!(is_public(v4(ip)), "{ip} should be reachable");
        }
        assert!(is_public(v6("2606:4700:4700::1111")));
    }

    #[test]
    fn loopback_and_private_ranges_are_blocked() {
        for ip in [
            "127.0.0.1",
            "127.1.2.3",
            "10.0.0.1",
            "172.16.5.4",
            "172.31.255.255",
            "192.168.1.1",
            "0.0.0.0",
        ] {
            assert!(!is_public(v4(ip)), "{ip} must be blocked");
        }
    }

    #[test]
    fn the_cloud_metadata_endpoint_is_blocked() {
        // 169.254.169.254 is the single highest-value SSRF target in any
        // cloud deployment: it hands out instance credentials.
        assert!(!is_public(v4("169.254.169.254")));
        assert!(!is_public(v4("169.254.0.1")));
    }

    #[test]
    fn carrier_grade_nat_and_reserved_space_are_blocked() {
        for ip in [
            "100.64.0.1",
            "100.127.255.255",
            "192.0.0.1",
            "198.18.0.1",
            "198.19.255.255",
            "240.0.0.1",
            "255.255.255.255",
            "224.0.0.1",
        ] {
            assert!(!is_public(v4(ip)), "{ip} must be blocked");
        }
    }

    #[test]
    fn cgnat_boundaries_are_exact() {
        // 100.64.0.0/10 is 100.64.x – 100.127.x. The neighbours are ordinary
        // public space and must stay reachable.
        assert!(is_public(v4("100.63.255.255")));
        assert!(!is_public(v4("100.64.0.0")));
        assert!(!is_public(v4("100.127.255.255")));
        assert!(is_public(v4("100.128.0.0")));
    }

    #[test]
    fn ipv6_local_ranges_are_blocked() {
        for ip in ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"] {
            assert!(!is_public(v6(ip)), "{ip} must be blocked");
        }
    }

    #[test]
    fn ipv4_addresses_tunnelled_through_ipv6_are_still_judged_as_ipv4() {
        // The classic bypass: ::ffff:127.0.0.1 is loopback wearing a costume.
        assert!(!is_public(v6("::ffff:127.0.0.1")));
        assert!(!is_public(v6("::ffff:169.254.169.254")));
        assert!(!is_public(v6("::ffff:10.0.0.1")));
        assert!(is_public(v6("::ffff:8.8.8.8")));
    }

    #[tokio::test]
    async fn non_http_schemes_never_reach_the_network() {
        let error = fetch_text("file:///etc/passwd", 1024, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn a_literal_private_address_is_refused_before_connecting() {
        for url in [
            "http://127.0.0.1:5432/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]:6379/",
        ] {
            let error = fetch_text(url, 1024, Duration::from_millis(500))
                .await
                .unwrap_err();
            assert!(
                matches!(error, AppError::BadRequest(_)),
                "{url} should have been refused"
            );
        }
    }
}
