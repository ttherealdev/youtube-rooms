//! A deliberately tiny Prometheus exporter.
//!
//! We export a handful of numbers that answer real operational questions, and
//! we do it with atomics rather than pulling in a metrics framework. The most
//! important series here is `sync_drift_ms` — it is the product's SLO
//! (ADR 0005 §5), not a vanity gauge.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct Metrics {
    pub ws_connections: AtomicI64,
    pub ws_messages_in: AtomicU64,
    pub ws_messages_out: AtomicU64,
    pub ws_dropped_slow_clients: AtomicU64,
    pub rooms_active: AtomicI64,
    pub rooms_owned: AtomicI64,
    pub chat_messages: AtomicU64,
    pub sync_intents: AtomicU64,
    pub rate_limited: AtomicU64,
    pub http_requests: AtomicU64,

    /// Drift samples, bucketed. Reported by clients every 10 s.
    drift: DriftHistogram,
}

/// Fixed buckets in milliseconds. Chosen around the ±150 ms perceptual target
/// so the interesting resolution sits where decisions get made.
const DRIFT_BUCKETS_MS: [f64; 8] = [25.0, 50.0, 100.0, 150.0, 250.0, 500.0, 1000.0, 2500.0];

#[derive(Debug, Default)]
struct DriftHistogram {
    buckets: [AtomicU64; DRIFT_BUCKETS_MS.len()],
    overflow: AtomicU64,
    count: AtomicU64,
    /// Sum of absolute drift, in microseconds, to keep integer precision.
    sum_us: AtomicU64,
}

impl Metrics {
    pub fn record_drift(&self, drift_ms: f64) {
        let abs = drift_ms.abs();
        let mut placed = false;
        for (idx, edge) in DRIFT_BUCKETS_MS.iter().enumerate() {
            if abs <= *edge {
                self.drift.buckets[idx].fetch_add(1, Ordering::Relaxed);
                placed = true;
                break;
            }
        }
        if !placed {
            self.drift.overflow.fetch_add(1, Ordering::Relaxed);
        }
        self.drift.count.fetch_add(1, Ordering::Relaxed);
        self.drift
            .sum_us
            .fetch_add((abs * 1000.0) as u64, Ordering::Relaxed);
    }

    /// Approximate quantile from the bucket edges. Good enough to alert on and
    /// honest about being an upper bound within its bucket.
    pub fn drift_quantile(&self, q: f64) -> Option<f64> {
        let total = self.drift.count.load(Ordering::Relaxed);
        if total == 0 {
            return None;
        }
        let target = (total as f64 * q).ceil() as u64;
        let mut cumulative = 0u64;
        for (idx, edge) in DRIFT_BUCKETS_MS.iter().enumerate() {
            cumulative += self.drift.buckets[idx].load(Ordering::Relaxed);
            if cumulative >= target {
                return Some(*edge);
            }
        }
        Some(f64::INFINITY)
    }

    pub fn render_prometheus(&self) -> String {
        use std::fmt::Write as _;
        let mut out = String::with_capacity(2048);

        let gauge = |out: &mut String, name: &str, help: &str, value: i64| {
            let _ = writeln!(out, "# HELP {name} {help}");
            let _ = writeln!(out, "# TYPE {name} gauge");
            let _ = writeln!(out, "{name} {value}");
        };
        let counter = |out: &mut String, name: &str, help: &str, value: u64| {
            let _ = writeln!(out, "# HELP {name} {help}");
            let _ = writeln!(out, "# TYPE {name} counter");
            let _ = writeln!(out, "{name} {value}");
        };

        gauge(
            &mut out,
            "ytroom_ws_connections",
            "Currently open WebSocket connections on this node.",
            self.ws_connections.load(Ordering::Relaxed),
        );
        gauge(
            &mut out,
            "ytroom_rooms_active",
            "Rooms with at least one connection on this node.",
            self.rooms_active.load(Ordering::Relaxed),
        );
        gauge(
            &mut out,
            "ytroom_rooms_owned",
            "Rooms whose authoritative timeline this node holds.",
            self.rooms_owned.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "ytroom_ws_messages_in_total",
            "Client messages accepted.",
            self.ws_messages_in.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "ytroom_ws_messages_out_total",
            "Server messages enqueued.",
            self.ws_messages_out.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "ytroom_ws_slow_clients_total",
            "Connections closed for failing to drain their outbound queue.",
            self.ws_dropped_slow_clients.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "ytroom_chat_messages_total",
            "Chat messages persisted.",
            self.chat_messages.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "ytroom_sync_intents_total",
            "Playback intents accepted.",
            self.sync_intents.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "ytroom_rate_limited_total",
            "Actions rejected by a rate limiter.",
            self.rate_limited.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "ytroom_http_requests_total",
            "HTTP requests handled.",
            self.http_requests.load(Ordering::Relaxed),
        );

        // The number an operator actually alerts on.
        if let Some(p95) = self.drift_quantile(0.95) {
            gauge(
                &mut out,
                "ytroom_sync_drift_p95_ms",
                "Approximate 95th percentile of absolute client playback drift.",
                p95 as i64,
            );
        }

        let _ = writeln!(
            out,
            "# HELP ytroom_sync_drift_ms Absolute playback drift reported by clients."
        );
        let _ = writeln!(out, "# TYPE ytroom_sync_drift_ms histogram");
        let mut cumulative = 0u64;
        for (idx, edge) in DRIFT_BUCKETS_MS.iter().enumerate() {
            cumulative += self.drift.buckets[idx].load(Ordering::Relaxed);
            let _ = writeln!(
                out,
                "ytroom_sync_drift_ms_bucket{{le=\"{edge}\"}} {cumulative}"
            );
        }
        cumulative += self.drift.overflow.load(Ordering::Relaxed);
        let _ = writeln!(out, "ytroom_sync_drift_ms_bucket{{le=\"+Inf\"}} {cumulative}");
        let _ = writeln!(
            out,
            "ytroom_sync_drift_ms_sum {}",
            self.drift.sum_us.load(Ordering::Relaxed) as f64 / 1000.0
        );
        let _ = writeln!(
            out,
            "ytroom_sync_drift_ms_count {}",
            self.drift.count.load(Ordering::Relaxed)
        );

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantiles_are_none_until_there_is_data() {
        let m = Metrics::default();
        assert!(m.drift_quantile(0.95).is_none());
    }

    #[test]
    fn quantile_lands_in_the_right_bucket() {
        let m = Metrics::default();
        for _ in 0..95 {
            m.record_drift(30.0); // bucket edge 50
        }
        for _ in 0..5 {
            m.record_drift(900.0); // bucket edge 1000
        }
        assert_eq!(m.drift_quantile(0.5), Some(50.0));
        assert_eq!(m.drift_quantile(0.99), Some(1000.0));
    }

    #[test]
    fn sign_is_ignored_when_bucketing() {
        let m = Metrics::default();
        m.record_drift(-120.0);
        assert_eq!(m.drift_quantile(0.5), Some(150.0));
    }

    #[test]
    fn exposition_is_wellformed() {
        let m = Metrics::default();
        m.record_drift(10.0);
        let text = m.render_prometheus();
        assert!(text.contains("ytroom_sync_drift_ms_count 1"));
        assert!(text.contains("le=\"+Inf\""));
        assert!(text.contains("# TYPE ytroom_ws_connections gauge"));
    }
}
