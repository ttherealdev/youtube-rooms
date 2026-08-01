import type { MediaSource } from '@playercn/protocol';
import { type EngineEvents, type PlayerEngine, usableDuration } from './engine';

/**
 * Playback for everything that is not YouTube: direct files, HLS and DASH.
 *
 * All three end up driving the same `<video>` element; the difference is only
 * in how bytes reach it. A plain file is assigned to `src`; HLS and DASH need a
 * Media Source Extensions library to fetch segments and feed the buffer — and
 * both libraries are imported dynamically, so a room playing a YouTube video
 * never downloads either.
 *
 * The one genuine subtlety is Safari. It plays HLS natively via `src`, and
 * attaching hls.js on top of that fights the built-in implementation, so the
 * native path is preferred wherever it exists.
 */
export class MediaEngine implements PlayerEngine {
  readonly kind: MediaSource['kind'];

  #video: HTMLVideoElement;
  #events: EngineEvents;
  #buffering = false;
  #ready = false;
  #destroyed = false;
  /** hls.js / dash.js instance, when one is in use. */
  #streaming: { destroy: () => void } | null = null;
  #detach: Array<() => void> = [];

  constructor(video: HTMLVideoElement, source: MediaSource, events: EngineEvents = {}) {
    this.#video = video;
    this.#events = events;
    this.kind = source.kind;

    // The room now waits for `onReady` before it starts the clock, so the
    // element has to actually go and fetch something. Left at the browser
    // default of `metadata`, a plain file loads its header, fires
    // `loadedmetadata`, and then sits there — the room starts, playback begins
    // from an empty buffer, and the first thing the viewer sees is a stall.
    video.preload = 'auto';

    this.#bindEvents();
    void this.#attachSource(source);
  }

  #bindEvents(): void {
    const video = this.#video;

    const on = <K extends keyof HTMLMediaElementEventMap>(
      event: K,
      handler: (e: HTMLMediaElementEventMap[K]) => void,
    ) => {
      video.addEventListener(event, handler);
      this.#detach.push(() => video.removeEventListener(event, handler));
    };

    on('loadedmetadata', () => {
      this.#markReady();
      const duration = usableDuration(video.duration);
      if (duration !== null) this.#events.onDurationChange?.(duration);
    });

    // `durationchange` also fires when an HLS VOD manifest finishes parsing,
    // which is usually after `loadedmetadata` — so the length is often only
    // knowable here.
    on('durationchange', () => {
      const duration = usableDuration(video.duration);
      if (duration !== null) this.#events.onDurationChange?.(duration);
    });

    on('waiting', () => this.#setBuffering(true));
    on('stalled', () => this.#setBuffering(true));
    on('playing', () => {
      this.#markReady();
      this.#setBuffering(false);
    });
    on('canplay', () => {
      this.#markReady();
      this.#setBuffering(false);
    });

    on('ended', () => this.#events.onEnded?.());
    on('play', () => this.#events.onIntentPlay?.());
    on('pause', () => this.#events.onIntentPause?.());

    on('error', () => {
      const code = video.error?.code;
      this.#events.onError?.(describeMediaError(code));
    });
  }

  /**
   * Announce readiness exactly once.
   *
   * Three different events can be the first to prove the source is playable —
   * `loadedmetadata`, `canplay` and `playing` — and which one wins varies by
   * container and browser. The room only wants to be told the first time.
   */
  #markReady(): void {
    if (this.#ready) return;
    this.#ready = true;
    this.#events.onReady?.();
  }

  #setBuffering(next: boolean): void {
    if (this.#buffering === next) return;
    this.#buffering = next;
    this.#events.onBufferingChange?.(next);
  }

  async #attachSource(source: MediaSource): Promise<void> {
    const video = this.#video;

    if (source.kind === 'file') {
      video.src = source.url;
      // Explicit: assigning `src` on an element that already played something
      // does not always restart the resource selection algorithm on its own.
      video.load();
      return;
    }

    if (source.kind === 'hls') {
      // Safari and iOS play HLS natively. Layering hls.js over that competes
      // with the platform implementation instead of helping it.
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source.url;
        return;
      }

      const { default: Hls } = await import('hls.js');
      if (this.#destroyed) return;

      if (!Hls.isSupported()) {
        this.#events.onError?.('This browser cannot play HLS streams.');
        return;
      }

      const hls = new Hls({
        // The room is the authority on position, so a large forward buffer
        // just delays how fast a corrective seek can take effect.
        maxBufferLength: 30,
        enableWorker: true,
      });
      this.#streaming = hls;

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        // Network and media errors are frequently transient on public streams;
        // the library can recover from both if asked. Only give up otherwise.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          this.#events.onError?.('This stream could not be played.');
        }
      });

      hls.loadSource(source.url);
      hls.attachMedia(video);
      return;
    }

    if (source.kind === 'dash') {
      const dashjs = await import('dashjs');
      if (this.#destroyed) return;

      const player = dashjs.MediaPlayer().create();
      player.initialize(video, source.url, false);
      this.#streaming = { destroy: () => player.destroy() };
      return;
    }

    this.#events.onError?.('Unsupported source.');
  }

  currentTime(): number {
    return this.#video.currentTime;
  }

  duration(): number | null {
    return usableDuration(this.#video.duration);
  }

  buffering(): boolean {
    return this.#buffering;
  }

  ready(): boolean {
    return this.#ready;
  }

  async play(): Promise<void> {
    try {
      await this.#video.play();
    } catch {
      // Autoplay was refused. That is not an error worth surfacing: the room
      // shows its own "click to join playback" affordance, and throwing here
      // would abort the sync loop that produced the call.
    }
  }

  pause(): void {
    this.#video.pause();
  }

  seek(seconds: number): void {
    // Seeking a stream whose buffer does not yet cover the target throws in
    // some browsers rather than clamping, so guard against the obvious cases.
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.#video.currentTime = seconds;
  }

  setRate(rate: number): void {
    this.#video.playbackRate = rate;
  }

  setVolume(volume: number): void {
    this.#video.volume = Math.min(1, Math.max(0, volume));
  }

  setMuted(muted: boolean): void {
    this.#video.muted = muted;
  }

  destroy(): void {
    this.#destroyed = true;
    for (const detach of this.#detach) detach();
    this.#detach = [];

    this.#streaming?.destroy();
    this.#streaming = null;

    // Explicitly dropping the source stops the browser from continuing to
    // download a stream for a room the user has already left.
    this.#video.removeAttribute('src');
    this.#video.load();
  }
}

function describeMediaError(code: number | undefined): string {
  switch (code) {
    case 1:
      return 'Loading was aborted.';
    case 2:
      return 'The network dropped while loading this source.';
    case 3:
      return 'This file is corrupt, or uses a codec this browser cannot decode.';
    case 4:
      // By far the most common real failure: a link that is fine in VLC but
      // that the browser either cannot decode or cannot fetch cross-origin.
      return 'This source cannot be played here — the format may be unsupported, or the server may not allow playback from another site.';
    default:
      return 'This source could not be played.';
  }
}
