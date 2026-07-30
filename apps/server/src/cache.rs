//! Redis access and the key namespace.
//!
//! Every key this service writes is named here. Scattering key strings through
//! the codebase is how you end up with two features quietly sharing a key.

use anyhow::Context;
use redis::aio::ConnectionManager;
use uuid::Uuid;

/// Multiplexed, auto-reconnecting handle. Cloning is cheap and shares the
/// underlying connection.
pub type Redis = ConnectionManager;

pub async fn connect(url: &str) -> anyhow::Result<Redis> {
    let client = redis::Client::open(url).context("invalid REDIS_URL")?;
    let manager = ConnectionManager::new(client)
        .await
        .context("could not connect to Redis")?;
    Ok(manager)
}

/// A dedicated (non-multiplexed) connection, required for blocking pub/sub.
pub async fn pubsub_connection(url: &str) -> anyhow::Result<redis::aio::PubSub> {
    let client = redis::Client::open(url).context("invalid REDIS_URL")?;
    let pubsub = client
        .get_async_pubsub()
        .await
        .context("could not open Redis pub/sub connection")?;
    Ok(pubsub)
}

pub mod keys {
    use uuid::Uuid;

    /// Pub/sub channel every node subscribes to for a room it has listeners in.
    pub fn room_channel(room_id: &Uuid) -> String {
        format!("ytr:room:{room_id}:events")
    }

    /// Lease identifying which node owns a room's authoritative timeline.
    pub fn room_owner(room_id: &Uuid) -> String {
        format!("ytr:room:{room_id}:owner")
    }

    /// Serialized timeline, so a new owner can rehydrate after a node dies.
    pub fn room_timeline(room_id: &Uuid) -> String {
        format!("ytr:room:{room_id}:timeline")
    }

    /// Sorted set of user ids scored by last-seen timestamp.
    pub fn room_presence(room_id: &Uuid) -> String {
        format!("ytr:room:{room_id}:presence")
    }

    pub fn ws_ticket(ticket_hash: &str) -> String {
        format!("ytr:ticket:{ticket_hash}")
    }

    pub fn oauth_state(state_hash: &str) -> String {
        format!("ytr:oauth:{state_hash}")
    }

    pub fn video_metadata(video_id: &str) -> String {
        format!("ytr:video:{video_id}")
    }

    pub fn rate_limit(scope: &str, subject: &str) -> String {
        format!("ytr:rl:{scope}:{subject}")
    }
}

/// Set a JSON value with an expiry.
pub async fn set_json<T: serde::Serialize>(
    redis: &mut Redis,
    key: &str,
    value: &T,
    ttl: std::time::Duration,
) -> anyhow::Result<()> {
    let payload = serde_json::to_string(value)?;
    let _: () = redis::cmd("SET")
        .arg(key)
        .arg(payload)
        .arg("PX")
        .arg(ttl.as_millis() as u64)
        .query_async(redis)
        .await?;
    Ok(())
}

pub async fn get_json<T: serde::de::DeserializeOwned>(
    redis: &mut Redis,
    key: &str,
) -> anyhow::Result<Option<T>> {
    let raw: Option<String> = redis::cmd("GET").arg(key).query_async(redis).await?;
    match raw {
        None => Ok(None),
        Some(text) => Ok(serde_json::from_str(&text).ok()),
    }
}

/// Atomically read and delete — the single-use semantics WebSocket tickets and
/// OAuth state both need. A GET followed by a DEL would be replayable in the
/// window between them.
pub async fn take_json<T: serde::de::DeserializeOwned>(
    redis: &mut Redis,
    key: &str,
) -> anyhow::Result<Option<T>> {
    let raw: Option<String> = redis::cmd("GETDEL").arg(key).query_async(redis).await?;
    match raw {
        None => Ok(None),
        Some(text) => Ok(serde_json::from_str(&text).ok()),
    }
}

/// Claim or renew ownership of a room.
///
/// `SET key node NX PX ttl` claims it; if we already hold it, we renew. The
/// renewal path checks the current holder first so a node can never extend
/// someone else's lease.
pub async fn claim_room_lease(
    redis: &mut Redis,
    room_id: &Uuid,
    node_id: &str,
    ttl: std::time::Duration,
) -> anyhow::Result<bool> {
    let key = keys::room_owner(room_id);
    let claimed: Option<String> = redis::cmd("SET")
        .arg(&key)
        .arg(node_id)
        .arg("NX")
        .arg("PX")
        .arg(ttl.as_millis() as u64)
        .query_async(redis)
        .await?;

    if claimed.is_some() {
        return Ok(true);
    }

    // Renew only if we are still the holder. Compare-and-extend in one round
    // trip, so a lease that expired between GET and EXPIRE cannot be revived.
    const RENEW: &str = r"
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('PEXPIRE', KEYS[1], ARGV[2])
        else
            return 0
        end";

    let renewed: i64 = redis::Script::new(RENEW)
        .key(&key)
        .arg(node_id)
        .arg(ttl.as_millis() as u64)
        .invoke_async(redis)
        .await?;

    Ok(renewed == 1)
}

/// Give up a lease during a graceful drain so another node can take over
/// immediately instead of waiting out the TTL.
pub async fn release_room_lease(
    redis: &mut Redis,
    room_id: &Uuid,
    node_id: &str,
) -> anyhow::Result<()> {
    const RELEASE: &str = r"
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        else
            return 0
        end";

    let _: i64 = redis::Script::new(RELEASE)
        .key(keys::room_owner(room_id))
        .arg(node_id)
        .invoke_async(redis)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::keys;
    use uuid::Uuid;

    #[test]
    fn keys_are_namespaced_and_distinct() {
        let room = Uuid::nil();
        let all = [
            keys::room_channel(&room),
            keys::room_owner(&room),
            keys::room_timeline(&room),
            keys::room_presence(&room),
        ];
        assert!(all.iter().all(|k| k.starts_with("ytr:")));
        let unique: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(unique.len(), all.len(), "key collision between room concerns");
    }
}
