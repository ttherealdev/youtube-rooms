import type { MediaSource } from '@playercn/protocol';
import {
  describePlayerError,
  loadYouTubeApi,
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
      playerVars: { ...PLAYER_VARS },
      events: {
        onReady: ({ target }) => {
          if (this.#destroyed) {
            target.destroy();
            return;
          }
          this.#player = target;
          this.#applyPending();

          const duration = usableDuration(target.getDuration());
          if (duration !== null) this.#events.onDurationChange?.(duration);
        },

        onStateChange: ({ data, target }) => {
          this.#setBuffering(data === PlayerState.Buffering);

          if (data === PlayerState.Ended) this.#events.onEnded?.();
          if (data === PlayerState.Playing) {
            this.#events.onIntentPlay?.();
            // Duration is often still zero at `onReady` and only becomes real
            // once playback actually starts.
            const duration = usableDuration(target.getDuration());
            if (duration !== null) this.#events.onDurationChange?.(duration);
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

  #setBuffering(next: boolean): void {
    if (this.#buffering === next) return;
    this.#buffering = next;
    this.#events.onBufferingChange?.(next);
  }

  currentTime(): number {
    return this.#player?.getCurrentTime() ?? this.#pending.position ?? 0;
  }

  duration(): number | null {
    return usableDuration(this.#player?.getDuration());
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
