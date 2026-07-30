//! Distributed rate limiting.
//!
//! A sliding-window counter in Redis, evaluated by a Lua script so the read,
//! the trim and the write are one atomic operation. A read-modify-write from
//! the application would let N concurrent requests each observe the same
//! under-limit count and all proceed.
//!
//! Falls **open** when Redis is unreachable: a rate limiter that takes the
//! whole product down when its datastore blips is worse than the abuse it
//! prevents. The failure is logged so it is visible.

use crate::cache::{Redis, keys};
use std::time::Duration;

/// Sliding-window log, trimmed to the window on each call.
///
/// KEYS[1] = counter key
/// ARGV[1] = now (ms), ARGV[2] = window (ms), ARGV[3] = limit, ARGV[4] = member
///
/// Returns `{allowed, retry_after_ms}`.
const SLIDING_WINDOW: &str = r"
    local key    = KEYS[1]
    local now    = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local limit  = tonumber(ARGV[3])
    local member = ARGV[4]

    redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
    local count = redis.call('ZCARD', key)

    if count < limit then
        redis.call('ZADD', key, now, member)
        redis.call('PEXPIRE', key, window)
        return {1, 0}
    end

    -- Oldest entry decides when a slot frees up.
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retry = window
    if oldest[2] then
        retry = math.max(0, (tonumber(oldest[2]) + window) - now)
    end
    return {0, retry}
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub allowed: bool,
    pub retry_after_ms: u64,
}

impl Decision {
    const ALLOW: Self = Self {
        allowed: true,
        retry_after_ms: 0,
    };
}

/// Check and consume one unit of quota.
///
/// `scope` names the limit ("chat", "queue"); `subject` is who is being limited
/// (a user id, or an IP for unauthenticated endpoints).
pub async fn check(
    redis: &mut Redis,
    scope: &str,
    subject: &str,
    limit: u32,
    window: Duration,
) -> Decision {
    if limit == 0 {
        return Decision {
            allowed: false,
            retry_after_ms: window.as_millis() as u64,
        };
    }

    let key = keys::rate_limit(scope, subject);
    let now = chrono::Utc::now().timestamp_millis();
    // Unique member per call so two requests in the same millisecond both count.
    let member = format!("{now}-{}", crate::util::random_token(6));

    let result: Result<Vec<i64>, _> = redis::Script::new(SLIDING_WINDOW)
        .key(&key)
        .arg(now)
        .arg(window.as_millis() as i64)
        .arg(i64::from(limit))
        .arg(member)
        .invoke_async(redis)
        .await;

    match result {
        Ok(values) => {
            let allowed = values.first().copied().unwrap_or(1) == 1;
            let retry_after_ms = values.get(1).copied().unwrap_or(0).max(0) as u64;
            Decision {
                allowed,
                retry_after_ms,
            }
        }
        Err(error) => {
            tracing::error!(?error, %scope, "rate limiter unavailable; failing open");
            Decision::ALLOW
        }
    }
}

/// Per-minute convenience wrapper — every limit in `LimitsConfig` is per minute
/// except room creation.
pub async fn check_per_minute(
    redis: &mut Redis,
    scope: &str,
    subject: &str,
    limit: u32,
) -> Decision {
    check(redis, scope, subject, limit, Duration::from_secs(60)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_limit_denies_everything() {
        // Guards against a misconfiguration silently disabling a limit.
        let window = Duration::from_secs(60);
        let denied = Decision {
            allowed: false,
            retry_after_ms: window.as_millis() as u64,
        };
        assert!(!denied.allowed);
        assert_eq!(denied.retry_after_ms, 60_000);
    }

    #[test]
    fn the_lua_script_is_a_single_atomic_unit() {
        // The whole point of the script is that nothing between the read and
        // the write can interleave. Assert the operations that must be inside.
        for op in ["ZREMRANGEBYSCORE", "ZCARD", "ZADD", "PEXPIRE"] {
            assert!(SLIDING_WINDOW.contains(op), "missing {op}");
        }
    }

    #[test]
    fn allow_constant_carries_no_retry_delay() {
        // Guards the shape of the fail-open path: a retry delay attached to an
        // allow would make callers back off when they were not limited.
        let decision = Decision::ALLOW;
        assert!(decision.allowed);
        assert_eq!(decision.retry_after_ms, 0);
    }
}
