import { CLOCK } from '@playercn/protocol';

/**
 * Estimates the offset between this browser's clock and the server's.
 *
 * Implements ADR 0005 §1: Cristian's algorithm with NTP-style filtering. The
 * whole synchronisation design rests on this number being right, so the
 * estimator is deliberately conservative — it would rather report low
 * confidence than a wrong offset.
 *
 * Two things matter and are easy to get wrong:
 *
 * 1. **Local time comes from `performance.now()`, never `Date.now()`.** A
 *    mid-session NTP correction on the user's machine steps `Date.now()`
 *    sideways and would silently corrupt every sample taken across it.
 *
 * 2. **Low-RTT samples are the trustworthy ones.** A sample's error is bounded
 *    by RTT/2, so a slow round trip is a noisy one. Discarding high-RTT samples
 *    and taking the *median* of what remains is what stops one queued packet
 *    from dragging the estimate.
 */

export interface ClockSample {
  /** Round-trip time in milliseconds. */
  rtt: number;
  /** Estimated (server − local) offset in milliseconds. */
  offset: number;
  /** When the sample was taken, on the monotonic clock. */
  at: number;
}

export interface ClockStatus {
  offsetMs: number;
  /** Round-trip time of the best surviving sample. */
  rttMs: number;
  /** How many samples survived filtering. */
  samples: number;
  /**
   * Whether the estimate is trustworthy enough for sub-second corrections.
   * Below this, the player holds off rather than converging onto a bad clock.
   */
  confident: boolean;
}

/** Monotonic wall-clock reading, immune to system clock steps. */
export function monotonicNow(): number {
  return performance.timeOrigin + performance.now();
}

export class ClockEstimator {
  #samples: ClockSample[] = [];
  #offset = 0;
  #rtt = 0;

  /**
   * Fold in one probe.
   *
   * @param clientSent  value sent in the ping, echoed by the server
   * @param serverTime  server clock reading at the moment it handled the ping
   */
  addSample(clientSent: number, serverTime: number): void {
    const now = monotonicNow();
    const rtt = now - clientSent;

    // A negative or absurd RTT means the echo did not correspond to this
    // request, or the tab was suspended mid-flight. Either way it is not data.
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 10_000) return;

    // Cristian's estimator: assume the reply took half the round trip.
    const offset = serverTime + rtt / 2 - now;
    if (!Number.isFinite(offset)) return;

    this.#samples.push({ rtt, offset, at: now });
    if (this.#samples.length > CLOCK.WINDOW) {
      this.#samples.shift();
    }

    this.#recompute();
  }

  /**
   * Seed from the `ready` snapshot so the first frame is approximately right
   * instead of assuming zero offset until the first ping lands.
   */
  seed(serverTime: number): void {
    if (this.#samples.length > 0) return;
    this.#offset = serverTime - monotonicNow();
  }

  #recompute(): void {
    if (this.#samples.length === 0) return;

    // 20th percentile of RTT — the "this connection is behaving normally" mark.
    const sortedByRtt = [...this.#samples].sort((a, b) => a.rtt - b.rtt);
    const index = Math.floor(sortedByRtt.length * 0.2);
    const baseline = sortedByRtt[Math.min(index, sortedByRtt.length - 1)]?.rtt ?? 0;
    const ceiling = baseline * CLOCK.RTT_ACCEPT_MULTIPLIER;

    // Always keep at least the single best sample, so a uniformly slow but
    // consistent connection still produces an estimate.
    const survivors =
      sortedByRtt.filter((sample) => sample.rtt <= ceiling).length > 0
        ? sortedByRtt.filter((sample) => sample.rtt <= ceiling)
        : sortedByRtt.slice(0, 1);

    const offsets = survivors.map((sample) => sample.offset).sort((a, b) => a - b);
    this.#offset = median(offsets);
    this.#rtt = survivors[0]?.rtt ?? 0;
    this.#survivorCount = survivors.length;
  }

  #survivorCount = 0;

  /** Server time, right now, as best we can tell. */
  serverNow(): number {
    return monotonicNow() + this.#offset;
  }

  get status(): ClockStatus {
    return {
      offsetMs: this.#offset,
      rttMs: this.#rtt,
      samples: this.#survivorCount,
      confident: this.#survivorCount >= CLOCK.MIN_CONFIDENT_SAMPLES,
    };
  }

  /**
   * Discard history after a reconnect. The route may have changed completely,
   * making every prior RTT sample misleading about the new path.
   */
  reset(): void {
    this.#samples = [];
    this.#survivorCount = 0;
    this.#rtt = 0;
    // The offset is deliberately *kept*: it is still the best guess we have
    // while the new burst converges, and zeroing it would make the player jump.
  }
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Probe schedule: a fast burst on connect to converge before the user notices,
 * then a slow steady state.
 *
 * Returns a stop function.
 */
export function startProbing(send: () => void, onStop?: () => void): () => void {
  let stopped = false;
  let burstsLeft = CLOCK.BURST_COUNT;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    if (stopped) return;

    // A hidden tab is throttled to ~1 Hz and its timers are unreliable, so a
    // probe taken there measures the throttle, not the network.
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      send();
    }

    const delay = burstsLeft > 0 ? CLOCK.BURST_INTERVAL_MS : CLOCK.STEADY_INTERVAL_MS;
    if (burstsLeft > 0) burstsLeft -= 1;
    timer = setTimeout(tick, delay);
  };

  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    onStop?.();
  };
}
