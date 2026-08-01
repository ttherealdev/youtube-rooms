//! The authoritative playback timeline.
//!
//! See `docs/adr/0005-video-synchronization.md`. The single idea that makes
//! this work: **position is derived, never stored**. A timeline records where
//! playback was at a known server instant, and any observer computes the
//! current position from that anchor against the same clock. Late joiners,
//! delayed packets and reconnects all collapse into the same arithmetic — there
//! is no catch-up path because there is nothing to catch up to.
//!
//! This module is pure. It performs no I/O and holds no locks, which is what
//! lets the whole thing be exhaustively unit-tested.

use crate::media::MediaSource;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Rates every player we drive actually honours. An arbitrary float here would
/// be silently clamped by the player, desynchronising the room against its own
/// authoritative record.
pub const ALLOWED_RATES: [f64; 8] = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

pub fn is_allowed_rate(rate: f64) -> bool {
    ALLOWED_RATES.iter().any(|r| (r - rate).abs() < f64::EPSILON)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    /// `None` means the room is idle — nothing loaded, nothing playing.
    pub source: Option<MediaSource>,
    /// Playback position, in seconds, that was true at `anchor_at`.
    pub anchor_pos: f64,
    /// Server clock (ms since epoch) the anchor was taken at.
    pub anchor_at: i64,
    pub rate: f64,
    pub paused: bool,
    /// Monotonic. Clients discard any timeline not strictly newer than theirs.
    pub version: u64,
    pub queue_item_id: Option<Uuid>,
    /// `loop` on the wire. Renamed for the same reason as `ReadyPayload::self_user`:
    /// the protocol name is a Rust keyword, and `rename_all` would otherwise emit
    /// `loopCurrent`, which the client's schema rejects.
    #[serde(rename = "loop")]
    pub loop_current: bool,
    /// Duration of the loaded video, when known. Used to clamp seeks and to
    /// decide when the video has ended.
    pub duration: Option<f64>,
}

impl Timeline {
    /// An empty room: nothing loaded, paused at zero.
    pub fn idle(now_ms: i64) -> Self {
        Self {
            source: None,
            anchor_pos: 0.0,
            anchor_at: now_ms,
            rate: 1.0,
            paused: true,
            version: 0,
            queue_item_id: None,
            loop_current: false,
            duration: None,
        }
    }

    /// Position at a given **server** instant.
    ///
    /// Clamped at zero, and at the video duration when it is known, so a
    /// timeline left running past the end does not report a position beyond it.
    pub fn position_at(&self, server_now_ms: i64) -> f64 {
        if self.source.is_none() {
            return 0.0;
        }
        if self.paused {
            return self.clamp_position(self.anchor_pos);
        }
        let elapsed_s = (server_now_ms - self.anchor_at) as f64 / 1000.0;
        self.clamp_position(self.anchor_pos + elapsed_s * self.rate)
    }

    fn clamp_position(&self, pos: f64) -> f64 {
        let lower = pos.max(0.0);
        match self.duration {
            Some(d) if d > 0.0 => lower.min(d),
            _ => lower,
        }
    }

    /// True once playback has run past the end of a known-duration video.
    pub fn has_ended(&self, server_now_ms: i64) -> bool {
        match (self.source.as_ref(), self.duration) {
            (Some(_), Some(duration)) if duration > 0.0 && !self.paused => {
                let elapsed_s = (server_now_ms - self.anchor_at) as f64 / 1000.0;
                self.anchor_pos + elapsed_s * self.rate >= duration
            }
            _ => false,
        }
    }

    /// Re-anchor to the present without changing what is playing.
    ///
    /// Every mutation goes through this so the invariant "anchor_pos is true at
    /// anchor_at" can never be violated by forgetting to update one of the pair.
    fn reanchor(&mut self, now_ms: i64) {
        self.anchor_pos = self.position_at(now_ms);
        self.anchor_at = now_ms;
        self.version += 1;
    }

    pub fn play(&mut self, now_ms: i64) {
        if self.source.is_none() {
            return;
        }
        self.reanchor(now_ms);
        self.paused = false;
    }

    pub fn pause(&mut self, now_ms: i64) {
        if self.source.is_none() {
            return;
        }
        self.reanchor(now_ms);
        self.paused = true;
    }

    pub fn seek(&mut self, now_ms: i64, position: f64) {
        if self.source.is_none() {
            return;
        }
        // Take the anchor first so the version bump and clamping stay in one place.
        self.reanchor(now_ms);
        self.anchor_pos = self.clamp_position(position.max(0.0));
    }

    /// Change speed while preserving the current position exactly. Without the
    /// re-anchor, every past second would be retroactively recomputed at the new
    /// rate and the room would jump.
    pub fn set_rate(&mut self, now_ms: i64, rate: f64) {
        if !is_allowed_rate(rate) || self.source.is_none() {
            return;
        }
        self.reanchor(now_ms);
        self.rate = rate;
    }

    pub fn set_loop(&mut self, loop_current: bool) {
        self.loop_current = loop_current;
        self.version += 1;
    }

    /// Load a source and begin playing from the start.
    pub fn load(
        &mut self,
        now_ms: i64,
        source: MediaSource,
        queue_item_id: Option<Uuid>,
        duration: Option<f64>,
    ) {
        self.source = Some(source);
        self.queue_item_id = queue_item_id;
        self.duration = duration;
        self.anchor_pos = 0.0;
        self.anchor_at = now_ms;
        self.paused = false;
        self.version += 1;
    }

    /// Record a duration discovered at playback time.
    ///
    /// Only YouTube tells us how long a video is before it plays. For a file or
    /// a stream the length is not known until a client has loaded it and read
    /// its metadata, so the client reports it back and the room learns the
    /// bound it needs in order to clamp seeks and auto-advance.
    ///
    /// Ignored once a duration is known: a second client reporting a slightly
    /// different value must not re-anchor the room, and a live stream that
    /// reports a growing duration must not drag the end of the video with it.
    pub fn set_duration(&mut self, duration: f64) -> bool {
        if self.source.is_none() || self.duration.is_some() {
            return false;
        }
        if !duration.is_finite() || duration <= 0.0 {
            return false;
        }
        self.duration = Some(duration);
        self.version += 1;
        true
    }

    /// Is a source currently loaded?
    pub fn is_loaded(&self) -> bool {
        self.source.is_some()
    }

    /// Clear the room back to idle, preserving the version counter so clients
    /// still accept the update.
    pub fn clear(&mut self, now_ms: i64) {
        let version = self.version + 1;
        *self = Self::idle(now_ms);
        self.version = version;
    }

    pub fn restart(&mut self, now_ms: i64) {
        if self.source.is_none() {
            return;
        }
        self.reanchor(now_ms);
        self.anchor_pos = 0.0;
        self.paused = false;
    }

    /// Drift of an observed position against the authority, in milliseconds.
    /// Positive means the observer is *ahead*.
    pub fn drift_ms(&self, observed_position: f64, server_now_ms: i64) -> f64 {
        (observed_position - self.position_at(server_now_ms)) * 1000.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::SourceKind;

    const T0: i64 = 1_700_000_000_000;

    fn playing() -> Timeline {
        let mut tl = Timeline::idle(T0);
        tl.load(T0, MediaSource::youtube("dQw4w9WgXcQ".into()), None, Some(212.0));
        tl
    }

    #[test]
    fn idle_room_reports_zero_regardless_of_elapsed_time() {
        let tl = Timeline::idle(T0);
        assert_eq!(tl.position_at(T0 + 60_000), 0.0);
    }

    #[test]
    fn position_advances_with_wall_clock() {
        let tl = playing();
        assert!((tl.position_at(T0 + 10_000) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn paused_position_is_frozen() {
        let mut tl = playing();
        tl.pause(T0 + 5_000);
        assert!((tl.position_at(T0 + 60_000) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn resuming_continues_from_where_it_paused() {
        let mut tl = playing();
        tl.pause(T0 + 5_000);
        tl.play(T0 + 60_000);
        assert!((tl.position_at(T0 + 63_000) - 8.0).abs() < 1e-9);
    }

    #[test]
    fn rate_change_preserves_current_position() {
        let mut tl = playing();
        // 10 s in at 1.0x, then double speed.
        tl.set_rate(T0 + 10_000, 2.0);
        assert!((tl.position_at(T0 + 10_000) - 10.0).abs() < 1e-9);
        // Two more wall-clock seconds should advance four video seconds.
        assert!((tl.position_at(T0 + 12_000) - 14.0).abs() < 1e-9);
    }

    #[test]
    fn invalid_rates_are_ignored_rather_than_clamped() {
        let mut tl = playing();
        let before = tl.version;
        tl.set_rate(T0 + 1_000, 3.7);
        assert_eq!(tl.rate, 1.0);
        assert_eq!(tl.version, before, "a rejected intent must not bump version");
    }

    #[test]
    fn seek_clamps_to_the_video_bounds() {
        let mut tl = playing();
        tl.seek(T0, -50.0);
        assert_eq!(tl.position_at(T0), 0.0);
        tl.seek(T0, 9_999.0);
        assert!((tl.position_at(T0) - 212.0).abs() < 1e-9);
    }

    #[test]
    fn position_never_exceeds_duration_even_if_left_running() {
        let tl = playing();
        assert!((tl.position_at(T0 + 10_000_000) - 212.0).abs() < 1e-9);
    }

    #[test]
    fn every_accepted_mutation_bumps_the_version() {
        let mut tl = playing();
        let mut last = tl.version;
        for step in 0..5 {
            let now = T0 + step * 1_000;
            match step {
                0 => tl.pause(now),
                1 => tl.play(now),
                2 => tl.seek(now, 30.0),
                3 => tl.set_rate(now, 1.5),
                _ => tl.restart(now),
            }
            assert!(tl.version > last, "step {step} did not bump version");
            last = tl.version;
        }
    }

    #[test]
    fn mutations_on_an_idle_room_are_no_ops() {
        let mut tl = Timeline::idle(T0);
        let before = tl.clone();
        tl.play(T0 + 1);
        tl.pause(T0 + 2);
        tl.seek(T0 + 3, 42.0);
        tl.set_rate(T0 + 4, 2.0);
        tl.restart(T0 + 5);
        assert_eq!(tl, before, "idle room must not accept playback intents");
    }

    #[test]
    fn has_ended_only_once_past_duration() {
        let tl = playing();
        assert!(!tl.has_ended(T0 + 211_000));
        assert!(tl.has_ended(T0 + 213_000));
    }

    #[test]
    fn paused_video_at_the_end_has_not_ended() {
        // Otherwise a room paused on the final frame would auto-advance forever.
        let mut tl = playing();
        tl.seek(T0, 212.0);
        tl.pause(T0);
        assert!(!tl.has_ended(T0 + 10_000_000));
    }

    #[test]
    fn ended_respects_playback_rate() {
        let mut tl = playing();
        tl.set_rate(T0, 2.0);
        assert!(!tl.has_ended(T0 + 105_000));
        assert!(tl.has_ended(T0 + 107_000));
    }

    #[test]
    fn drift_sign_is_positive_when_the_client_runs_ahead() {
        let tl = playing();
        // Authority says 10.0 s; client reports 10.2 s.
        let drift = tl.drift_ms(10.2, T0 + 10_000);
        assert!((drift - 200.0).abs() < 1e-6, "got {drift}");
    }

    #[test]
    fn a_late_joiner_derives_the_same_position_as_everyone_else() {
        // The property the whole design exists to provide: an observer that has
        // never seen any prior event computes the identical position purely from
        // the record, at any instant.
        let mut tl = playing();
        tl.pause(T0 + 30_000);
        tl.play(T0 + 90_000);

        let late = tl.clone(); // exactly what a joining client receives
        for offset in [0, 1_000, 25_000, 60_000] {
            let at = T0 + 90_000 + offset;
            assert_eq!(tl.position_at(at), late.position_at(at));
        }
    }

    #[test]
    fn clear_preserves_version_monotonicity() {
        let mut tl = playing();
        tl.seek(T0, 40.0);
        let before = tl.version;
        tl.clear(T0 + 1_000);
        assert!(tl.version > before);
        assert!(tl.source.is_none());
    }

    fn unknown_length() -> Timeline {
        // What a file or stream looks like when it is first loaded: playing,
        // but with no idea how long it is.
        let mut tl = Timeline::idle(T0);
        tl.load(
            T0,
            MediaSource {
                kind: SourceKind::File,
                url: "https://cdn.example.com/clip.mp4".into(),
                video_id: None,
            },
            None,
            None,
        );
        tl
    }

    #[test]
    fn a_client_can_teach_the_room_how_long_an_unknown_source_is() {
        let mut tl = unknown_length();
        assert!(tl.set_duration(90.0));
        assert_eq!(tl.duration, Some(90.0));
        // And the room can now clamp against it.
        tl.seek(T0, 9_999.0);
        assert!((tl.position_at(T0) - 90.0).abs() < 1e-9);
    }

    #[test]
    fn only_the_first_duration_report_is_accepted() {
        // Otherwise every client in the room re-anchors the timeline as it
        // loads, and a room of ten people gets ten spurious updates.
        let mut tl = unknown_length();
        assert!(tl.set_duration(90.0));
        assert!(!tl.set_duration(91.5));
        assert_eq!(tl.duration, Some(90.0));
    }

    #[test]
    fn a_youtube_duration_known_up_front_is_not_overwritten() {
        let mut tl = playing();
        assert!(!tl.set_duration(10.0), "the API already told us");
        assert_eq!(tl.duration, Some(212.0));
    }

    #[test]
    fn a_live_stream_never_gains_a_duration() {
        // Browsers report `Infinity` for a live HLS stream. Accepting it would
        // make `has_ended` true immediately and skip the channel.
        let mut tl = unknown_length();
        assert!(!tl.set_duration(f64::INFINITY));
        assert!(!tl.set_duration(f64::NAN));
        assert!(!tl.set_duration(0.0));
        assert!(!tl.set_duration(-5.0));
        assert_eq!(tl.duration, None);
        assert!(!tl.has_ended(T0 + 10_000_000));
    }

    #[test]
    fn an_idle_room_ignores_a_duration_report() {
        let mut tl = Timeline::idle(T0);
        assert!(!tl.set_duration(90.0));
        assert_eq!(tl.duration, None);
    }

    #[test]
    fn accepting_a_duration_bumps_the_version_so_clients_apply_it() {
        let mut tl = unknown_length();
        let before = tl.version;
        assert!(tl.set_duration(90.0));
        assert!(tl.version > before);
    }

    #[test]
    fn allowed_rate_table_matches_the_protocol() {
        assert!(is_allowed_rate(1.0));
        assert!(is_allowed_rate(0.25));
        assert!(is_allowed_rate(2.0));
        assert!(!is_allowed_rate(0.0));
        assert!(!is_allowed_rate(2.5));
    }
}
