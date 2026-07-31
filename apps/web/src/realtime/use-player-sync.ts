import { decideCorrection, positionAt, SYNC, type Timeline } from '@youtube-room/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomSocket } from './socket';
import {
  describePlayerError,
  loadYouTubeApi,
  PLAYER_VARS,
  PlayerState,
  type YouTubePlayer,
} from './youtube';

/**
 * Keeps one browser's player locked to the authoritative timeline.
 *
 * This is the client half of ADR 0005. The decision logic itself lives in the
 * pure `decideCorrection` (in `@youtube-room/protocol`, exhaustively tested);
 * everything here is the imperative plumbing around it.
 *
 * The important non-obvious detail: **the playback head never enters React
 * state.** It is written to a ref every animation frame and read by whatever
 * needs it. A `useState` here would re-render the entire room subtree at
 * 60 Hz — chat, queue, participant list and all (ADR 0008).
 */

export interface PlayerSyncHandle {
  /** Attach to the container the iframe should replace. */
  containerRef: (node: HTMLDivElement | null) => void;
  /** Live playback position, in seconds. Read from rAF, never rendered directly. */
  positionRef: React.RefObject<number>;
  durationRef: React.RefObject<number>;
  ready: boolean;
  buffering: boolean;
  error: string | null;
  /** Last measured drift, for the debug overlay. */
  driftRef: React.RefObject<number>;
  setVolume: (value: number) => void;
  getVolume: () => number;
  requestFullscreen: () => void;
}

export function usePlayerSync(
  socket: RoomSocket | null,
  timeline: Timeline | null,
): PlayerSyncHandle {
  const playerRef = useRef<YouTubePlayer | null>(null);
  const containerElement = useRef<HTMLDivElement | null>(null);
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const driftRef = useRef(0);
  const loadedVideoRef = useRef<string | null>(null);
  const nudgingRef = useRef(false);
  const timelineRef = useRef<Timeline | null>(timeline);

  const [ready, setReady] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  timelineRef.current = timeline;

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    containerElement.current = node;
  }, []);

  // --- Create the player once -----------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const host = containerElement.current;
    if (!host) return;

    void loadYouTubeApi()
      .then((api) => {
        if (cancelled) return;

        const mount = document.createElement('div');
        host.appendChild(mount);

        playerRef.current = new api.Player(mount, {
          playerVars: { ...PLAYER_VARS },
          events: {
            onReady: () => {
              if (!cancelled) setReady(true);
            },
            onStateChange: (event) => {
              if (cancelled) return;
              setBuffering(event.data === PlayerState.Buffering);
              if (event.data === PlayerState.Playing) {
                durationRef.current = event.target.getDuration();
              }
            },
            onError: (event) => {
              if (!cancelled) setError(describePlayerError(event.data));
            },
          },
        });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load the player.');
        }
      });

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  // --- Load / swap the video ------------------------------------------------
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !ready || !socket) return;

    const videoId = timeline?.videoId ?? null;
    if (videoId === loadedVideoRef.current) return;

    loadedVideoRef.current = videoId;
    setError(null);

    if (!videoId) {
      player.pauseVideo();
      return;
    }

    // Start at the derived position, not at zero — a late joiner must not
    // rewind everyone else, and must not begin from the top themselves.
    const startAt = timeline ? positionAt(timeline, socket.clock.serverNow()) : 0;

    if (timeline?.paused) {
      player.cueVideoById(videoId, startAt);
    } else {
      player.loadVideoById(videoId, startAt);
    }
  }, [ready, socket, timeline]);

  // --- Follow play/pause and rate ------------------------------------------
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !ready || !timeline?.videoId) return;

    const state = player.getPlayerState();
    const isPlaying = state === PlayerState.Playing || state === PlayerState.Buffering;

    if (timeline.paused && isPlaying) player.pauseVideo();
    if (!timeline.paused && !isPlaying) player.playVideo();

    // Only reset the rate when we are not mid-nudge, or the correction loop
    // would immediately undo its own convergence every time this effect runs.
    if (!nudgingRef.current && player.getPlaybackRate() !== timeline.rate) {
      player.setPlaybackRate(timeline.rate);
    }
  }, [ready, timeline]);

  // --- The correction loop --------------------------------------------------
  useEffect(() => {
    if (!ready || !socket) return;

    const interval = setInterval(() => {
      const player = playerRef.current;
      const current = timelineRef.current;
      if (!player || !current?.videoId) return;

      // A backgrounded tab is throttled to ~1 Hz and its player may be
      // suspended entirely; any "drift" measured there is an artefact.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

      const observed = player.getCurrentTime();
      const target = positionAt(current, socket.clock.serverNow());
      driftRef.current = (observed - target) * 1000;

      const state = player.getPlayerState();
      const decision = decideCorrection(observed, target, current.rate, {
        buffering: state === PlayerState.Buffering,
        confident: socket.clock.status.confident,
        paused: current.paused,
      });

      switch (decision.action) {
        case 'seek':
          player.seekTo(decision.position, true);
          player.setPlaybackRate(current.rate);
          nudgingRef.current = false;
          break;

        case 'nudge':
          player.setPlaybackRate(decision.playbackRate);
          nudgingRef.current = true;
          break;

        case 'none':
          // Converged — restore the nominal rate so the nudge does not
          // overshoot into drift in the opposite direction.
          if (nudgingRef.current) {
            player.setPlaybackRate(current.rate);
            nudgingRef.current = false;
          }
          break;
      }
    }, SYNC.CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [ready, socket]);

  // --- Drift telemetry ------------------------------------------------------
  useEffect(() => {
    if (!ready || !socket) return;

    const interval = setInterval(() => {
      const player = playerRef.current;
      if (!player || !timelineRef.current?.videoId) return;

      socket.send({
        t: 'sync_report',
        driftMs: driftRef.current,
        position: Math.max(0, player.getCurrentTime()),
        buffering: player.getPlayerState() === PlayerState.Buffering,
      });
    }, SYNC.REPORT_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [ready, socket]);

  // --- Position tick for the progress bar -----------------------------------
  useEffect(() => {
    if (!ready) return;
    let frame = 0;

    const tick = () => {
      const player = playerRef.current;
      if (player) {
        positionRef.current = player.getCurrentTime();
        const duration = player.getDuration();
        if (duration > 0) durationRef.current = duration;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  const setVolume = useCallback((value: number) => {
    playerRef.current?.setVolume(Math.max(0, Math.min(100, value)));
  }, []);

  const getVolume = useCallback(() => playerRef.current?.getVolume() ?? 100, []);

  const requestFullscreen = useCallback(() => {
    const host = containerElement.current;
    if (!host) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void host.requestFullscreen?.();
  }, []);

  return {
    containerRef,
    positionRef,
    durationRef,
    driftRef,
    ready,
    buffering,
    error,
    setVolume,
    getVolume,
    requestFullscreen,
  };
}
