import { z } from 'zod';
import { epochMs, mediaSource, playbackRate, seconds } from './primitives.ts';

/**
 * The authoritative playback record. See docs/adr/0005-video-synchronization.md.
 *
 * Position is never stored — it is *derived* from an anchor. That single
 * property is what makes late joins, delayed packets and reconnects all reduce
 * to the same code path.
 */
export const timeline = z.object({
  /** `null` means the room is idle — nothing loaded, nothing playing. */
  source: mediaSource.nullable(),
  /** Playback position that was true at `anchorAt`. */
  anchorPos: seconds,
  /** Server clock reading the anchor was taken at. */
  anchorAt: epochMs,
  rate: playbackRate,
  paused: z.boolean(),
  /** Monotonic. Clients MUST discard any timeline whose version is not greater. */
  version: z.number().int().min(0),
  /** Queue item currently playing, if the video came from the queue. */
  queueItemId: z.uuid().nullable(),
  /** Loop the current video when it ends. */
  loop: z.boolean(),
  /**
   * Length in seconds, once known. YouTube reports it up front; a file or
   * stream stays `null` until a client that has loaded it reports back, and a
   * live stream stays `null` forever.
   */
  duration: z.number().nullable(),
  /**
   * The source is cued but held: the room is waiting for a player to report it
   * can start. Position stays at zero throughout, so a large file is not
   * skipped before anyone has downloaded a frame of it.
   */
  awaitingStart: z.boolean(),
});
export type Timeline = z.infer<typeof timeline>;

/**
 * Evaluate the timeline at a given *server* instant.
 *
 * The caller is responsible for passing server time — i.e. local time plus the
 * offset produced by the clock estimator. Passing raw `Date.now()` here is the
 * single most likely way to get this wrong, which is why the parameter is named
 * `serverNowMs` rather than `now`.
 */
export function positionAt(tl: Timeline, serverNowMs: number): number {
  if (tl.source === null) return 0;
  if (tl.paused) return tl.anchorPos;
  const elapsed = (serverNowMs - tl.anchorAt) / 1000;
  return Math.max(0, tl.anchorPos + elapsed * tl.rate);
}

/** Correction bands from ADR 0005 §3. Exported so client and tests agree. */
export const SYNC = {
  /** Below this, do nothing — it is under both perception and player resolution. */
  DEAD_BAND_MS: 50,
  /** Above this, seek; below it, nudge the playback rate instead. */
  HARD_SEEK_MS: 1500,
  /** Rate multiplier applied while walking off a drift. ±5% is inaudible. */
  NUDGE_FACTOR: 0.05,
  /** How often the client compares itself to the timeline. */
  CHECK_INTERVAL_MS: 1000,
  /** How often the client reports measured drift back to the server. */
  REPORT_INTERVAL_MS: 10_000,
} as const;

export type Correction =
  | { action: 'none' }
  /** Walk the drift off by running slightly fast or slow. Imperceptible. */
  | { action: 'nudge'; playbackRate: number }
  /** Too far gone to walk back; accept the stutter. */
  | { action: 'seek'; position: number };

/**
 * Decide how to reconcile a player against the authoritative timeline.
 *
 * This is the three-band correction from ADR 0005 §3 and it is the single
 * function that determines whether a room *feels* synchronised. It is pure so
 * that every band, boundary and suppression rule is exhaustively testable
 * without a browser.
 *
 * @param observed  the player's real position, in seconds
 * @param target    where it should be, in seconds
 * @param rate      the timeline's nominal playback rate
 * @param opts.buffering  suppress everything while the player rebuffers
 * @param opts.confident  suppress fine corrections until the clock is trusted
 */
export function decideCorrection(
  observed: number,
  target: number,
  rate: number,
  opts: { buffering: boolean; confident: boolean; paused: boolean },
): Correction {
  // A paused player is exactly where the timeline says it is; "drift" while
  // paused is meaningless and correcting it would fight the user's own seek.
  if (opts.paused) return { action: 'none' };

  // Correcting during a rebuffer makes it worse: the seek discards the buffer
  // the player just filled, and the user gets a seek storm instead of playback.
  if (opts.buffering) return { action: 'none' };

  const driftMs = (observed - target) * 1000;
  const magnitude = Math.abs(driftMs);

  if (!Number.isFinite(driftMs)) return { action: 'none' };

  // Below the dead band we are inside both human perception and the ~250 ms
  // resolution of the IFrame API's own position reporting. Acting on noise here
  // produces visible oscillation.
  if (magnitude < SYNC.DEAD_BAND_MS) return { action: 'none' };

  if (magnitude >= SYNC.HARD_SEEK_MS) {
    return { action: 'seek', position: target };
  }

  // Inside the nudge band but with an untrustworthy clock: the "drift" may be
  // our own offset error. Waiting is strictly better than converging onto it.
  if (!opts.confident) return { action: 'none' };

  // Ahead → slow down; behind → speed up.
  const direction = driftMs > 0 ? -1 : 1;
  return {
    action: 'nudge',
    playbackRate: rate * (1 + direction * SYNC.NUDGE_FACTOR),
  };
}

/** Clock estimator tuning from ADR 0005 §1. */
export const CLOCK = {
  /** Rapid probes on connect, to converge before the user notices anything. */
  BURST_COUNT: 8,
  BURST_INTERVAL_MS: 250,
  /** Steady-state probe cadence once converged. */
  STEADY_INTERVAL_MS: 10_000,
  /** Ring buffer size for offset samples. */
  WINDOW: 32,
  /** Keep samples whose RTT is within this multiple of the 20th percentile. */
  RTT_ACCEPT_MULTIPLIER: 1.5,
  /** Minimum surviving samples before the estimate is trusted for fine corrections. */
  MIN_CONFIDENT_SAMPLES: 3,
} as const;
