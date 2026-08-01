import type { MediaSource } from '@playercn/protocol';
import { apiUrl, getAccessToken } from '~/lib/api';
import { type EngineEvents, type PlayerEngine, usableDuration } from './engine';

/** Where the server's stream relay lives. */
const RELAY_PREFIX = apiUrl('/api/stream/');

/** Point a manifest URL at the relay. */
function relayUrl(url: string): string {
  return `${RELAY_PREFIX}manifest?url=${encodeURIComponent(url)}`;
}

/**
 * Playback for everything that is not YouTube: direct files, HLS and DASH.
 *
 * All three end up driving the same `<video>` element; the difference is only
 * in how bytes reach it. A plain file is assigned to `src`; HLS and DASH need a
 * Media Source Extensions library to fetch segments and feed the buffer — and
 * both libraries are imported dynamically, so a room playing a YouTube video
 * never downloads either.
 *
 * hls.js is preferred over native HLS everywhere it works, Safari included.
 * Native playback reports no renditions, cannot be routed through the relay,
 * and gives the room no way to distinguish a refused fetch from a broken file.
 * All three matter more than matching the platform player.
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
  /** Set once the engine has muted itself to get past autoplay policy. */
  #blocked = false;

  /**
   * Rendition control, populated only by the adaptive backends.
   *
   * A plain file has exactly one rendition, so the menu stays hidden for it
   * rather than offering a choice of one.
   */
  #renditions: { labels: string[]; get: () => string | null; set: (q: string | null) => void } = {
    labels: [],
    get: () => null,
    set: () => undefined,
  };

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

  /**
   * Attach hls.js to a URL, optionally through the server's relay.
   *
   * The relay exists because most public IPTV streams answer with a fixed
   * `Access-Control-Allow-Origin` naming their own site — Pluto's sends
   * `http://pluto.tv` — so the browser refuses the manifest no matter how valid
   * the link is. Nothing on the client can talk its way past that; only a
   * same-origin server can fetch it and pass it on.
   *
   * Direct is always tried first. A stream that works is played without costing
   * the server a byte, and only a refusal escalates.
   */
  #startHls(Hls: typeof import('hls.js').default, url: string, relayed: boolean): void {
    const hls = new Hls({
      // The room is the authority on position, so a large forward buffer just
      // delays how fast a corrective seek can take effect.
      maxBufferLength: 30,
      enableWorker: true,
      // The relay is authenticated, so its requests need the access token.
      // Upstream URLs are untouched — sending our token to a third party would
      // be handing it out.
      xhrSetup: (xhr: XMLHttpRequest, requestUrl: string) => {
        if (!requestUrl.startsWith(RELAY_PREFIX)) return;
        const token = getAccessToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      },
    });
    this.#streaming = hls;

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // A refused manifest is indistinguishable from an unreachable one at
        // this layer — the browser deliberately withholds the reason for a
        // blocked cross-origin response. Retrying through the relay answers
        // the question by removing the cross-origin part.
        if (!relayed) {
          hls.destroy();
          this.#streaming = null;
          this.#startHls(Hls, url, true);
          return;
        }
        // Already relayed, so this is the network genuinely failing. Public
        // streams drop constantly and recover, so keep asking.
        hls.startLoad();
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }

      this.#events.onError?.(
        relayed
          ? 'This stream could not be played, even through the server.'
          : 'This stream could not be played.',
      );
    });

    // Renditions become known when the manifest parses, not before.
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.#renditions = {
        labels: hls.levels.map(describeLevel),
        get: () => {
          const level = hls.levels[hls.currentLevel];
          // A negative index is hls.js reporting "I am choosing", which is what
          // a null rendition means to the room.
          return hls.currentLevel < 0 || !level ? null : describeLevel(level);
        },
        set: (quality) => {
          hls.currentLevel =
            quality === null
              ? -1
              : hls.levels.findIndex((level) => describeLevel(level) === quality);
        },
      };
      this.#events.onQualitiesChange?.();
    });

    hls.loadSource(relayed ? relayUrl(url) : url);
    hls.attachMedia(this.#video);
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
      const { default: Hls } = await import('hls.js');
      if (this.#destroyed) return;

      // hls.js is preferred over native playback wherever it works, including
      // on Safari. Native HLS reports no renditions, cannot be relayed, and
      // gives the room no way to tell a refused fetch from a broken file — all
      // three matter more than matching the platform player.
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = source.url;
          return;
        }
        this.#events.onError?.('This browser cannot play HLS streams.');
        return;
      }

      this.#startHls(Hls, source.url, false);
      return;
    }

    if (source.kind === 'dash') {
      const dashjs = await import('dashjs');
      if (this.#destroyed) return;

      const player = dashjs.MediaPlayer().create();
      player.initialize(video, source.url, false);
      this.#streaming = { destroy: () => player.destroy() };

      // dash.js v5 renamed the bitrate list to representations; the older
      // `getBitrateInfoListFor` no longer exists.
      player.on('streamInitialized', () => {
        const label = (r: { height: number; bitrateInKbit: number }) =>
          r.height ? `${r.height}p` : `${Math.round(r.bitrateInKbit)} kbps`;
        const tracks = player.getRepresentationsByType('video') ?? [];

        this.#renditions = {
          labels: tracks.map(label),
          get: () => {
            const current = player.getCurrentRepresentationForType('video');
            return current ? label(current) : null;
          },
          set: (quality) => {
            // Picking a rendition means switching adaptive selection off; the
            // player would otherwise override the choice on the next segment.
            player.updateSettings({
              streaming: { abr: { autoSwitchBitrate: { video: quality === null } } },
            });
            const index = tracks.findIndex((track) => label(track) === quality);
            if (index >= 0) player.setRepresentationForTypeByIndex('video', index);
          },
        };
        this.#events.onQualitiesChange?.();
      });

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

  /**
   * A manifest with no known duration is a live edge.
   *
   * `<video>.duration` is `Infinity` for live HLS, which `usableDuration`
   * already reduces to null — so this needs no extra bookkeeping, only the
   * observation that "adaptive source, no length" means live.
   */
  live(): boolean {
    return this.kind !== 'file' && this.duration() === null;
  }

  qualities(): string[] {
    return this.#renditions.labels;
  }

  quality(): string | null {
    return this.#renditions.get();
  }

  setQuality(quality: string | null): void {
    this.#renditions.set(quality);
  }

  /**
   * Start playing, recovering from an autoplay refusal.
   *
   * Unlike the embeds, a `<video>` says so plainly: `play()` returns a promise
   * that rejects with `NotAllowedError`. The room starts playback from its sync
   * loop rather than from a click, so every viewer who did not press play
   * themselves is asking for an unprompted audible start, which browsers
   * refuse. Muting is always permitted, so a refusal is retried silently and
   * the room offers the sound back.
   */
  async play(): Promise<void> {
    const video = this.#video;
    if (!video.paused) return;

    try {
      await video.play();
    } catch {
      // Already silent, or the user turned the sound back on deliberately —
      // either way a second attempt would not be any more permitted.
      if (video.muted || this.#blocked || this.#destroyed) return;

      this.#blocked = true;
      video.muted = true;
      try {
        await video.play();
        this.#events.onAudioBlocked?.();
      } catch {
        // Refused even muted: something other than autoplay policy is wrong,
        // and the element's `error` event is what will explain it. Throwing
        // here would abort the sync loop that produced the call.
        video.muted = false;
        this.#blocked = false;
      }
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
    // Turning the sound back on is what clears the block, so a later corrective
    // play() does not immediately mute the viewer again.
    if (!muted) this.#blocked = false;
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

/**
 * A human label for an HLS level.
 *
 * Height alone is what people recognise; bitrate is the tiebreaker for the
 * streams that publish two renditions at the same resolution.
 */
function describeLevel(level: { height?: number; bitrate?: number }): string {
  if (level.height) return `${level.height}p`;
  return level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : 'Auto';
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
      // By far the most common real failure, and two very different causes
      // wearing one error code: the browser cannot decode the container, or
      // the server refused it cross-origin. Streams get a second chance
      // through the relay; a direct file has no equivalent, because the
      // element fetches it itself.
      return 'This file could not be played — the format may be unsupported, or the server may not allow playback from another site.';
    default:
      return 'This source could not be played.';
  }
}
