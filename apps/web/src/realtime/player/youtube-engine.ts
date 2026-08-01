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
 * YouTube's internal rendition names, in the order the API reports them.
 *
 * The API speaks in labels like `hd1080` and `large`, and nobody outside
 * YouTube knows that `large` means 480p. The menu shows the right-hand side and
 * this engine translates back, so the rest of the app never has to learn the
 * vocabulary.
 */
const QUALITY_LABELS: Record<string, string> = {
  highres: '4320p',
  hd2880: '2880p',
  hd2160: '2160p',
  hd1440: '1440p',
  hd1080: '1080p',
  hd720: '720p',
  large: '480p',
  medium: '360p',
  small: '240p',
  tiny: '144p',
};

/**
 * How long to wait before concluding the browser refused an audible start.
 *
 * Autoplay policy rejects playback no gesture asked for, and the IFrame API
 * reports that as *nothing happening at all*: no error, no state change, no
 * callback. Asking again shortly afterwards is the only way to notice.
 */
const AUTOPLAY_GRACE_MS = 1200;

/** How often to look for renditions, and for how long, once playback starts. */
const QUALITY_POLL_MS = 1000;
const QUALITY_POLL_LIMIT = 15;

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

  /** Human label to YouTube's name, for translating a menu choice back. */
  #levels = new Map<string, string>();
  #qualities: string[] = [];
  #pinned: string | null = null;

  #timers = new Set<ReturnType<typeof setTimeout>>();
  /** Set once the engine has muted itself to get past autoplay policy. */
  #blocked = false;
  /** An autoplay check is already outstanding; the sync loop must not add more. */
  #verifying = false;

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

    // The API *replaces* whatever element it is given with its iframe. Handing
    // it the room's shared mount destroyed that node: React still held a ref to
    // the detached original, the teardown's `replaceChildren()` then cleared a
    // node that was no longer in the document, and every dead player stayed
    // stacked in the DOM. It gets its own disposable child instead.
    const slot = document.createElement('div');
    slot.style.width = '100%';
    slot.style.height = '100%';
    container.appendChild(slot);

    const player = new api.Player(slot, {
      videoId: source.videoId,
      host: PLAYER_HOST,
      // Without these the API stamps its default 640×390 onto the iframe. That
      // is not just a layout bug: YouTube picks its rendition from the size of
      // the player, so a 640-wide iframe stretched over a 1080p-wide card was
      // being served 360p and upscaled. This is the fix for "the quality is
      // terrible" — not anything in the quality menu.
      width: '100%',
      height: '100%',
      playerVars: { ...PLAYER_VARS },
      events: {
        onReady: ({ target }) => {
          if (this.#destroyed) {
            target.destroy();
            return;
          }
          this.#player = target;
          this.#fillContainer(target);
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
            // Renditions do not exist until the player has chosen a stream, so
            // this is the first moment there is a menu to build.
            this.#pollQualities();
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

  /** Make the created iframe fill its container rather than sit at 640×390. */
  #fillContainer(player: YouTubePlayer): void {
    const frame = player.getIframe?.();
    if (!frame) return;
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.display = 'block';
    frame.setAttribute('width', '100%');
    frame.setAttribute('height', '100%');
  }

  #after(ms: number, run: () => void): void {
    const id = setTimeout(() => {
      this.#timers.delete(id);
      if (!this.#destroyed) run();
    }, ms);
    this.#timers.add(id);
  }

  /**
   * Look for renditions until they appear.
   *
   * `getAvailableQualityLevels()` answers with an empty array until the player
   * has actually selected a stream, and there is no event for the moment it
   * fills in — so the menu that was wired to `onQualitiesChange` never had
   * anything to show, and the room hid it as "this source offers no choice".
   */
  #pollQualities(attempt = 0): void {
    if (this.#destroyed || attempt >= QUALITY_POLL_LIMIT) return;

    const levels = this.#player?.getAvailableQualityLevels?.() ?? [];
    const named = levels.filter((level) => level in QUALITY_LABELS);

    if (named.length > 0) {
      this.#levels = new Map(named.map((level) => [QUALITY_LABELS[level] as string, level]));
      this.#qualities = named.map((level) => QUALITY_LABELS[level] as string);
      this.#events.onQualitiesChange?.();
      return;
    }

    this.#after(QUALITY_POLL_MS, () => this.#pollQualities(attempt + 1));
  }

  #applyPending(): void {
    const player = this.#player;
    if (!player) return;

    player.setPlaybackRate(this.#pending.rate);
    if (this.#pending.position !== null) {
      player.seekTo(this.#pending.position, true);
    }
    if (this.#pending.playing) this.#start();
    else player.pauseVideo();
  }

  /**
   * Start playing, working around the browser's autoplay policy.
   *
   * The room presses play on everyone's behalf, so for every viewer who did not
   * click it themselves this is an unprompted audible start — which browsers
   * refuse. YouTube's answer to being refused is to render its own play button
   * over the video and report nothing, and the room's click-lid sits on top of
   * that button, so the viewer is left staring at a still frame with no way to
   * recover. Muting is always permitted, so a refusal is retried silently and
   * the room is told to offer the sound back.
   */
  #start(): void {
    const player = this.#player;
    if (!player) return;

    // The sync loop calls play() on every tick, so this is the common path by
    // a wide margin: already going, nothing to do. Re-issuing the command would
    // also mean a fresh autoplay check every tick.
    const state = player.getPlayerState();
    if (state === PlayerState.Playing || state === PlayerState.Buffering) return;

    player.playVideo();
    if (this.#blocked || this.#verifying) return;

    this.#verifying = true;
    this.#after(AUTOPLAY_GRACE_MS, () => {
      this.#verifying = false;
      // Still meant to be playing, and demonstrably is not.
      if (!this.#pending.playing || !this.#player) return;
      const now = this.#player.getPlayerState();
      if (now === PlayerState.Playing || now === PlayerState.Buffering) return;

      this.#blocked = true;
      this.#player.mute();
      this.#player.playVideo();
      this.#events.onAudioBlocked?.();
    });
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
    return this.#qualities;
  }

  /**
   * The *pinned* rendition, not the one the player happens to be showing.
   *
   * Null means the room has left YouTube to choose. Reporting the level it
   * chose would tick a row in the menu that nobody selected, and make "Auto"
   * look like it was never applied.
   */
  quality(): string | null {
    return this.#pinned;
  }

  setQuality(quality: string | null): void {
    const player = this.#player;
    if (!player) return;

    if (quality === null) {
      this.#pinned = null;
      player.setPlaybackQualityRange?.('tiny', 'highres');
      player.setPlaybackQuality?.('default');
      return;
    }

    const level = this.#levels.get(quality);
    if (!level) return;
    this.#pinned = quality;
    // The range is what the modern player actually honours; the older setter is
    // called too because which one works has changed before and the losing call
    // costs nothing.
    player.setPlaybackQualityRange?.(level, level);
    player.setPlaybackQuality?.(level);
  }

  buffering(): boolean {
    return this.#buffering;
  }

  ready(): boolean {
    return this.#player !== null;
  }

  play(): void {
    this.#pending.playing = true;
    this.#start();
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
    // Turning the sound back on is what clears the block, so a later corrective
    // play() does not immediately mute the viewer again.
    if (!muted) this.#blocked = false;
    if (muted) this.#player.mute();
    else this.#player.unMute();
  }

  destroy(): void {
    this.#destroyed = true;
    for (const id of this.#timers) clearTimeout(id);
    this.#timers.clear();
    this.#player?.destroy();
    this.#player = null;
  }
}
