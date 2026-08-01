import type { MediaSource } from '@playercn/protocol';
import { type EngineEvents, type PlayerEngine, usableDuration } from './engine';

/**
 * How long to give `play()` before concluding the browser refused it.
 *
 * The embed reports a refusal by doing nothing — no event, no error — and
 * drawing its own click-to-play artwork over the video instead.
 */
const AUTOPLAY_GRACE_MS = 1200;

/**
 * The Twitch adapter.
 *
 * Twitch will not play outside its own embed — there is no manifest URL a
 * `<video>` could take — so this drives the official Embed JS API, which is the
 * only supported way to get `play`, `pause` and `seek` on a Twitch player.
 *
 * Two things shape the code. The API is constructed asynchronously and rejects
 * calls made before `READY`, so commands issued while it loads are recorded and
 * replayed — the same problem, and the same solution, as the YouTube adapter.
 * And the embed refuses to load unless told which page is embedding it, via
 * `parent`; getting that wrong is a blank black rectangle with a console error
 * and no callback, which is why it is read from the live location rather than
 * configured.
 */
export class TwitchEngine implements PlayerEngine {
  readonly kind = 'twitch' as const;

  #player: TwitchPlayer | null = null;
  #events: EngineEvents;
  #destroyed = false;
  #buffering = true;
  #announced = false;

  #timers = new Set<ReturnType<typeof setTimeout>>();
  /** Set once the engine has muted itself to get past autoplay policy. */
  #blocked = false;
  /** An autoplay check is already outstanding; the sync loop must not add more. */
  #verifying = false;

  /** Renditions, newest list wins. Twitch names them `1080p60`, `chunked`, … */
  #qualities: string[] = [];
  /** Menu label to the group name the embed's `setQuality` expects. */
  #groups = new Map<string, string>();
  #pinned: string | null = null;

  /** Commands issued before the player existed, replayed on ready. */
  #pending: { playing: boolean; position: number | null; volume: number; muted: boolean } = {
    playing: false,
    position: null,
    volume: 1,
    muted: false,
  };

  constructor(container: HTMLElement, source: MediaSource, events: EngineEvents = {}) {
    this.#events = events;
    void this.#create(container, source);
  }

  async #create(container: HTMLElement, source: MediaSource): Promise<void> {
    const target = parseTwitch(source.url);
    if (!target) {
      this.#events.onError?.('That Twitch link is not a channel or a video.');
      return;
    }

    let api: TwitchApi;
    try {
      api = await loadTwitchEmbed();
    } catch {
      this.#events.onError?.('The Twitch player could not be loaded.');
      return;
    }

    if (this.#destroyed) return;

    // The embed appends its iframe to whatever it is given, so it gets its own
    // node — reusing the shared mount would leave a dead iframe behind when the
    // room moves to a different kind of source.
    const mount = document.createElement('div');
    mount.style.width = '100%';
    mount.style.height = '100%';
    container.appendChild(mount);

    const player = new api.Player(mount, {
      width: '100%',
      height: '100%',
      ...(target.kind === 'channel' ? { channel: target.id } : { video: target.id }),
      parent: [window.location.hostname],
      autoplay: false,
      muted: false,
      // Twitch draws its own controls; the room's bar is the one that is
      // synchronised, so letting both exist invites people to drive the wrong
      // one and desynchronise themselves.
      controls: false,
    });

    player.addEventListener('ready', () => {
      if (this.#destroyed) return;
      this.#player = player;
      this.#applyPending();
      this.#markReady();
    });

    player.addEventListener('playing', () => {
      this.#markReady();
      this.#setBuffering(false);
      this.#events.onIntentPlay?.();

      const duration = usableDuration(player.getDuration?.());
      if (duration !== null) this.#events.onDurationChange?.(duration);

      // Renditions only exist once a stream has been selected, and the embed
      // offers no event for the moment they appear.
      this.#readQualities();
    });

    player.addEventListener('pause', () => this.#events.onIntentPause?.());
    player.addEventListener('ended', () => this.#events.onEnded?.());
    player.addEventListener('offline', () =>
      this.#events.onError?.('That Twitch channel is offline.'),
    );

    if (this.#destroyed) player.destroy?.();
  }

  /**
   * Announce readiness once.
   *
   * `ready` and `playing` can arrive in either order depending on whether the
   * channel is live, and the room only wants to be told the first time.
   */
  #markReady(): void {
    if (this.#announced) return;
    this.#announced = true;
    this.#setBuffering(false);
    this.#events.onReady?.();
  }

  #applyPending(): void {
    const player = this.#player;
    if (!player) return;

    player.setVolume(this.#pending.volume);
    player.setMuted(this.#pending.muted);
    if (this.#pending.position !== null) player.seek(this.#pending.position);
    if (this.#pending.playing) this.#start();
    else player.pause();
  }

  #after(ms: number, run: () => void): void {
    const id = setTimeout(() => {
      this.#timers.delete(id);
      if (!this.#destroyed) run();
    }, ms);
    this.#timers.add(id);
  }

  /**
   * Start playing, working around the browser's autoplay policy.
   *
   * This is the bug that made a live Twitch channel look like a still image.
   * The room presses play on everyone's behalf, so for every viewer who did not
   * click it themselves the call is an unprompted *audible* start, which
   * browsers refuse. Twitch answers a refusal by drawing its own play button
   * over the video and telling the page nothing — while the room's click-lid
   * sits on top of that button and swallows the click meant for it. The result
   * was a frozen frame, a working-looking pause icon, and no way out.
   *
   * Muting is always permitted, so a refusal is retried silently and the room
   * is told to offer the sound back.
   */
  #start(): void {
    const player = this.#player;
    if (!player) return;

    // The sync loop calls play() on every tick, so already-playing is the
    // common path. Returning early also stops each tick queueing its own check.
    if (player.isPaused?.() === false) return;

    player.play();
    if (this.#blocked || this.#verifying) return;

    this.#verifying = true;
    this.#after(AUTOPLAY_GRACE_MS, () => {
      this.#verifying = false;
      const current = this.#player;
      // Still meant to be playing, and demonstrably is not.
      if (!this.#pending.playing || !current) return;
      if (current.isPaused?.() !== true) return;

      this.#blocked = true;
      current.setMuted(true);
      current.play();
      this.#events.onAudioBlocked?.();
    });
  }

  #readQualities(): void {
    const options = this.#player?.getQualities?.() ?? [];

    const labels: string[] = [];
    const groups = new Map<string, string>();
    for (const option of options) {
      const group = option.group;
      if (!group || group === 'auto') continue;
      // `chunked` is Twitch's name for the source rendition; everything else
      // already reads as a resolution. Both arrive best-first.
      const label = group === 'chunked' ? 'Source' : (option.name ?? group);
      if (groups.has(label)) continue;
      groups.set(label, group);
      labels.push(label);
    }

    if (labels.join('|') === this.#qualities.join('|')) return;
    this.#qualities = labels;
    this.#groups = groups;
    this.#events.onQualitiesChange?.();
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
    // Live channels report zero, which `usableDuration` turns into null — the
    // room then treats the source as having no end, which is correct.
    return usableDuration(this.#player?.getDuration?.());
  }

  buffering(): boolean {
    return this.#buffering;
  }

  ready(): boolean {
    return this.#player !== null;
  }

  qualities(): string[] {
    return this.#qualities;
  }

  /** The pinned rendition, or null while Twitch is choosing adaptively. */
  quality(): string | null {
    return this.#pinned;
  }

  setQuality(quality: string | null): void {
    const player = this.#player;
    if (!player) return;

    if (quality === null) {
      this.#pinned = null;
      player.setQuality?.('auto');
      return;
    }

    const group = this.#groups.get(quality);
    if (!group) return;
    this.#pinned = quality;
    player.setQuality?.(group);
  }

  play(): void {
    this.#pending.playing = true;
    this.#start();
  }

  pause(): void {
    this.#pending.playing = false;
    this.#player?.pause();
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.#pending.position = seconds;
    // Seeking a live channel throws inside the embed rather than being ignored.
    if (this.duration() !== null) this.#player?.seek(seconds);
  }

  setRate(): void {
    // Twitch exposes no rate control. Silently doing nothing is right: the
    // room's rate menu is hidden for live sources anyway, and throwing here
    // would abort the sync loop that called it.
  }

  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, volume));
    this.#pending.volume = clamped;
    this.#player?.setVolume(clamped);
  }

  setMuted(muted: boolean): void {
    this.#pending.muted = muted;
    // Turning the sound back on is what clears the block, so a later corrective
    // play() does not immediately mute the viewer again.
    if (!muted) this.#blocked = false;
    this.#player?.setMuted(muted);
  }

  destroy(): void {
    this.#destroyed = true;
    for (const id of this.#timers) clearTimeout(id);
    this.#timers.clear();
    this.#player?.destroy?.();
    this.#player = null;
  }
}

/** `twitch.tv/<channel>` or `twitch.tv/videos/<id>`, already canonicalised. */
export function parseTwitch(url: string): { kind: 'channel' | 'video'; id: string } | null {
  try {
    const { pathname } = new URL(url);
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 2 && segments[0] === 'videos' && segments[1]) {
      return { kind: 'video', id: segments[1] };
    }
    if (segments.length === 1 && segments[0]) {
      return { kind: 'channel', id: segments[0] };
    }
    return null;
  } catch {
    return null;
  }
}

/** One entry of the embed's `getQualities()`. */
interface TwitchQuality {
  /** The value `setQuality` expects: `1080p60`, `chunked`, `auto`, … */
  group?: string;
  /** The display name, which is usually the group with a nicer `Source`. */
  name?: string;
}

interface TwitchPlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  getCurrentTime(): number;
  getDuration?(): number;
  /** The only way to tell that a `play()` was refused: the embed is silent. */
  isPaused?(): boolean;
  getQualities?(): TwitchQuality[];
  setQuality?(group: string): void;
  addEventListener(event: string, handler: () => void): void;
  destroy?(): void;
}

interface TwitchApi {
  Player: new (element: HTMLElement | string, options: Record<string, unknown>) => TwitchPlayer;
}

declare global {
  interface Window {
    Twitch?: { Player: TwitchApi['Player'] };
  }
}

let loader: Promise<TwitchApi> | undefined;

/** Load the embed script once per document, however many players mount. */
function loadTwitchEmbed(): Promise<TwitchApi> {
  if (loader) return loader;

  loader = new Promise<TwitchApi>((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('the Twitch embed is browser-only'));
      return;
    }
    if (window.Twitch?.Player) {
      resolve({ Player: window.Twitch.Player });
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-twitch-embed]');
    const script = existing ?? document.createElement('script');

    const settle = () => {
      if (window.Twitch?.Player) resolve({ Player: window.Twitch.Player });
      else reject(new Error('the Twitch embed loaded without a Player'));
    };

    script.addEventListener('load', settle);
    script.addEventListener('error', () =>
      reject(new Error('failed to load the Twitch embed script')),
    );

    if (!existing) {
      script.src = 'https://player.twitch.tv/js/embed/v1.js';
      script.async = true;
      script.dataset.twitchEmbed = 'true';
      document.head.appendChild(script);
    }
  });

  return loader;
}
