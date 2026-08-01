import { decideCorrection, positionAt, SYNC, type Timeline } from '@playercn/protocol';
import { useEffect, useRef } from 'react';
import type { PlayerEngine } from './player/engine';
import type { RoomSocket } from './socket';

/**
 * Keep a player on the room's timeline.
 *
 * This is the client half of ADR 0005. The rules that matter:
 *
 *   * Position is **derived** from the timeline against server time, never
 *     tracked incrementally. A late join, a tab that was backgrounded for ten
 *     minutes and a normal tick all take the identical code path.
 *   * Corrections are graded — do nothing, nudge the rate, or seek — because a
 *     seek is visible and a nudge is not. `decideCorrection` owns that policy
 *     and is exhaustively tested in the protocol package.
 *   * Nothing here lives in React state. The loop runs on an interval and talks
 *     to the player through refs; putting the playback head in state would
 *     re-render the entire room several times a second.
 */
export function usePlayerSync(
  engine: PlayerEngine | null,
  timeline: Timeline | null,
  socket: RoomSocket | null,
  options: { enabled?: boolean } = {},
): void {
  const enabled = options.enabled ?? true;

  // Read through refs so changing the timeline does not tear down the loop.
  const engineRef = useRef(engine);
  const timelineRef = useRef(timeline);
  const socketRef = useRef(socket);
  engineRef.current = engine;
  timelineRef.current = timeline;
  socketRef.current = socket;

  /** Rate we last pushed, so a nudge is not reapplied every tick. */
  const appliedRate = useRef(1);

  useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      const player = engineRef.current;
      const tl = timelineRef.current;
      const sock = socketRef.current;
      if (!player || !tl || !sock || !player.ready() || tl.source === null) return;

      const target = positionAt(tl, sock.clock.serverNow());
      const observed = player.currentTime();
      const { confident } = sock.clock.status;

      // Paused/playing is applied before position: correcting the position of a
      // player that is in the wrong play state just fights the user.
      if (tl.paused) {
        player.pause();
        // A paused room still has a definite position, and a player that
        // resumed on its own must be pulled back to it.
        if (Math.abs(observed - target) > SYNC.DEAD_BAND_MS / 1000) {
          player.seek(target);
        }
        return;
      }

      player.play();

      const correction = decideCorrection(observed, target, tl.rate, {
        buffering: player.buffering(),
        confident,
        paused: tl.paused,
      });

      switch (correction.action) {
        case 'seek':
          player.seek(correction.position);
          // The nominal rate is restored alongside the seek; leaving a nudge
          // applied after a hard correction makes the player drift straight
          // back out the other side.
          if (appliedRate.current !== tl.rate) {
            player.setRate(tl.rate);
            appliedRate.current = tl.rate;
          }
          break;

        case 'nudge':
          if (Math.abs(appliedRate.current - correction.playbackRate) > 1e-6) {
            player.setRate(correction.playbackRate);
            appliedRate.current = correction.playbackRate;
          }
          break;

        case 'none':
          // Back to the room's real speed once we are inside the dead band.
          if (Math.abs(appliedRate.current - tl.rate) > 1e-6) {
            player.setRate(tl.rate);
            appliedRate.current = tl.rate;
          }
          break;
      }
    };

    const interval = setInterval(tick, SYNC.CHECK_INTERVAL_MS);
    tick();
    return () => clearInterval(interval);
  }, [enabled]);

  // Drift reporting is a separate, much slower loop: it feeds the server's SLO
  // histogram and has nothing to do with correcting this client.
  useEffect(() => {
    if (!enabled) return;

    const report = () => {
      const player = engineRef.current;
      const tl = timelineRef.current;
      const sock = socketRef.current;
      if (!player || !tl || !sock || !player.ready() || tl.source === null || tl.paused) return;

      const target = positionAt(tl, sock.clock.serverNow());
      const observed = player.currentTime();
      if (!Number.isFinite(observed)) return;

      sock.send({
        t: 'sync_report',
        driftMs: (observed - target) * 1000,
        position: observed,
        buffering: player.buffering(),
      });
    };

    const interval = setInterval(report, SYNC.REPORT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);
}
