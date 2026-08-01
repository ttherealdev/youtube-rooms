import type { MediaSource } from '@playercn/protocol';
import {
  describePlayerError,
  loadYouTubeApi,
  PLAYER_HOST,
  PLAYER_VARS,
  PlayerState,
  type YouTubePlayer,
} from '~/realtime/youtube';
import { type EngineEvents, type PlayerEngine, usableDuration } from './engine';

/**
 * The YouTube adapter.
 *
 * The IFrame API is asynchronous to construct and rejects every call made
 * before `onReady`, so commands issued while it is still loading are recorded
 * as a desired state and applied once the player exists. Dropping them instead
 * is what produces the classic "room joined, everyone else is playing, my
 * player sits at 0:00" bug.
 */
export class YouTubeEngine implements PlayerEngine {
  readonly kind = 'youtube' as const;

  #player: YouTubePlayer | null = null;
  #events: EngineEvents;
  #destroyed = false;
  #buffering = false;
  /**
   * Whether this is a live broadcast.
   *
   * Load-bearing. `getDuration()` on a live stream returns the length of the
   * DVR window, which grows without bound — a stream that had been up for
   * months reported 3563 hours, the room adopted that as the video's length,
   * and the scrubber and the correction loop then fought each other over a
   * position that meant nothing. Live streams must report *no* duration.
   */
  #live = false;

  /** Commands issued before the player existed, replayed on ready. */
  #pending: { playing: boolean; position: number | null; rate: number } = {
    playing: false,
    position: null,
    rate: 1,
  };

  constructor(container: HTMLElement, source: MediaSource, events: EngineEvents = {}) {
    this.#events = events;
    void this.#create(container, source);
  }

  async #create(container: HTMLElement, source: MediaSource): Promise<void> {
    if (!source.videoId) {
      this.#events.onError?.('That YouTube link has no video id.');
      return;
    }

    let api: Awaited<ReturnType<typeof loadYouTubeApi>>;
    try {
      api = await loadYouTubeApi();
    } catch {
      this.#events.onError?.('The YouTube player could not be loaded.');
      return;
    }

    // The room may have moved on while the API was loading.
    if (this.#destroyed) return;

    const player = new api.Player(container, {
      videoId: source.videoId,
      host: PLAYER_HOST,
      playerVars: { ...PLAYER_VARS },
      events: {
        onReady: ({ target }) => {
          if (this.#destroyed) {
            target.destroy();
            return;
          }
          this.#player = target;
          this.#live = target.getVideoData?.()?.isLive ?? false;
          this.#applyPending();
          this.#events.onReady?.();
          if (this.#live) this.#events.onLive?.();

          this.#reportDuration(target);
        },

        onStateChange: ({ data, target }) => {
          this.#setBuffering(data === PlayerState.Buffering);

          if (data === PlayerState.Ended) this.#events.onEnded?.();
          if (data === PlayerState.Playing) {
            this.#events.onIntentPlay?.();
            // Both of these are often still wrong at `onReady` and only become
            // true once playback actually starts — `isLive` included.
            const wasLive = this.#live;
            this.#live = target.getVideoData?.()?.isLive ?? this.#live;
            if (this.#live && !wasLive) this.#events.onLive?.();
            this.#reportDuration(target);
          }
          if (data === PlayerState.Paused) this.#events.onIntentPause?.();
        },

        onError: ({ data }) => this.#events.onError?.(describePlayerError(data)),
      },
    });

    // Held only so an immediate destroy() can tear it down even if `onReady`
    // has not fired yet.
    if (this.#destroyed) player.destroy();
  }

  #applyPending(): void {
    const player = this.#player;
    if (!player) return;

    player.setPlaybackRate(this.#pending.rate);
    if (this.#pending.position !== null) {
      player.seekTo(this.#pending.position, true);
    }
    if (this.#pending.playing) player.playVideo();
    else player.pauseVideo();
  }

  /**
   * Report the length, unless there is no meaningful length to report.
   *
   * A live broadcast's `getDuration()` is its DVR window, not the length of
   * anything: reporting it makes the room believe the stream ends at an
   * arbitrary future point and auto-advance there.
   */
  #reportDuration(player: YouTubePlayer): void {
    if (this.#live) return;
    const duration = usableDuration(player.getDuration());
    if (duration !== null) this.#events.onDurationChange?.(duration);
  }

  #setBuffering(next: boolean): void {
    if (this.#buffering === next) return;
    this.#buffering = next;
    this.#events.onBufferingChange?.(next);
  }

  currentTime(): number {
    return this.#player?.getCurrentTime() ?? this.#pending.position ?? 0;
  }

  duration(): number | null {
    if (this.#live) return null;
    return usableDuration(this.#player?.getDuration());
  }

  live(): boolean {
    return this.#live;
  }

  qualities(): string[] {
    return this.#player?.getAvailableQualityLevels?.() ?? [];
  }

  quality(): string | null {
    return this.#player?.getPlaybackQuality?.() ?? null;
  }

  setQuality(quality: string): void {
    // Advisory on YouTube: the player treats it as a ceiling and still adapts
    // downwards on a poor connection, which is the behaviour people expect.
    this.#player?.setPlaybackQuality?.(quality);
  }

  buffering(): boolean {
    return this.#buffering;
  }

  ready(): boolean {
    return this.#player !== null;
  }

  play(): void {
    this.#pending.playing = true;
    this.#player?.playVideo();
  }

  pause(): void {
    this.#pending.playing = false;
    this.#player?.pauseVideo();
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.#pending.position = seconds;
    this.#player?.seekTo(seconds, true);
  }

  setRate(rate: number): void {
    this.#pending.rate = rate;
    this.#player?.setPlaybackRate(rate);
  }

  setVolume(volume: number): void {
    // The IFrame API takes 0–100 where every other player here takes 0–1.
    this.#player?.setVolume(Math.round(Math.min(1, Math.max(0, volume)) * 100));
  }

  setMuted(muted: boolean): void {
    if (!this.#player) return;
    if (muted) this.#player.mute();
    else this.#player.unMute();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#player?.destroy();
    this.#player = null;
  }
}
