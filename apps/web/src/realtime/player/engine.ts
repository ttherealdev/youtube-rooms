import type { MediaSource } from '@playercn/protocol';

/**
 * The playback abstraction.
 *
 * The sync engine (ADR 0005) only ever needs five things from a player: where
 * it is, whether it is stalled, and the ability to seek, play/pause and nudge
 * the rate. Everything else about a source — an iframe with a postMessage API,
 * a `<video>` element, a Media Source Extensions library attached to one — is
 * an implementation detail behind this interface.
 *
 * That is what makes "play anything, like VLC" tractable: the drift-correction
 * loop is written once against `PlayerEngine`, and adding a format is adding an
 * adapter rather than touching sync.
 */
export interface PlayerEngine {
  readonly kind: MediaSource['kind'];

  /** Current playback position, in seconds. */
  currentTime(): number;
  /** Total length in seconds, or `null` when unknown or live. */
  duration(): number | null;
  /** True while the player has stalled and is refilling its buffer. */
  buffering(): boolean;
  /** True once the player can actually accept commands. */
  ready(): boolean;

  /**
   * True when this source turned out to be a live broadcast.
   *
   * Distinct from the *kind* being live-capable. A YouTube URL is a normal
   * video right up until it is a 24/7 broadcast, and only the player knows
   * which — so the room has to ask rather than infer it from the link.
   */
  live?(): boolean;

  /**
   * Selectable renditions, best first, or empty when the source offers no
   * choice. Format is engine-specific and only ever displayed.
   */
  qualities?(): string[];
  /** The rendition in use, or null when the engine is choosing adaptively. */
  quality?(): string | null;
  /** `null` restores automatic selection where the engine supports it. */
  setQuality?(quality: string | null): void;

  play(): Promise<void> | void;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;

  /** Release every resource: listeners, media sessions, network requests. */
  destroy(): void;
}

/** What an engine reports back to the room, independently of the sync loop. */
export interface EngineEvents {
  /**
   * Fired once, when this player could actually start rendering the source.
   *
   * The room holds a freshly cued source until it hears this from someone —
   * see `Timeline.awaitingStart`. Without it the timeline starts advancing the
   * moment a source loads, which on a large file means the room reaches the end
   * before any player has decoded a frame.
   */
  onReady?: () => void;
  /**
   * The source turned out to be live, whatever its URL suggested.
   *
   * The room hides the scrubber and stops correcting position when this
   * fires — there is no position on a live edge to correct towards.
   */
  onLive?: () => void;
  /** Fired once the length becomes known. Live sources never fire it. */
  onDurationChange?: (seconds: number) => void;
  /** The set of selectable renditions changed, so the menu can rebuild. */
  onQualitiesChange?: () => void;
  /** Playback reached the end of the media. */
  onEnded?: () => void;
  /** Unrecoverable: the room should show a failure and allow a skip. */
  onError?: (message: string) => void;
  /** The user pressed play/pause in the player's own chrome. */
  onIntentPlay?: () => void;
  onIntentPause?: () => void;
  /** Buffering state changed, so the UI can show a spinner. */
  onBufferingChange?: (buffering: boolean) => void;
}

/**
 * A duration a browser reports for a live stream.
 *
 * `<video>.duration` is `Infinity` for live HLS and often `NaN` before
 * metadata loads. Both must be treated as "unknown" rather than reported: a
 * duration of `Infinity` makes every seek clamp to nothing, and `NaN` poisons
 * every comparison it touches.
 */
export function usableDuration(raw: number | undefined | null): number | null {
  if (raw == null) return null;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}
