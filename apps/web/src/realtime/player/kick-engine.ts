import type { MediaSource } from '@playercn/protocol';
import type { EngineEvents, PlayerEngine } from './engine';

/**
 * How long to wait for the embed before calling it unreachable.
 *
 * Kick is blocked outright in several countries, and a blocked iframe is
 * *silent*: cross-origin rules mean no `load`, no `error`, no way to inspect
 * it — the element simply never resolves. Without a deadline those viewers sat
 * behind "Waiting for everyone to load…" indefinitely, holding up a room whose
 * other members were watching fine. Generous, because this also has to cover a
 * genuinely slow connection.
 */
const REACHABLE_MS = 12_000;

/**
 * The Kick adapter.
 *
 * Kick publishes an embeddable player and no JavaScript API for it whatsoever —
 * the embed neither listens for a `message` from its parent nor posts one back,
 * and the only two things its URL accepts are `autoplay` and `muted`. There is
 * no supported way to reach into the iframe and call play, pause, seek, or set
 * a volume, and being cross-origin means there is no unsupported way either.
 *
 * So transport is done the only way that is actually available: by rebuilding
 * the iframe. Pausing tears the player down, playing puts it back, and muting
 * reloads it with the other setting. That sounds violent, and on a seekable
 * video it would be — but Kick is live-only, so there is no position to lose.
 * Rejoining a live stream puts you at the live edge, which is exactly where you
 * were. The cost is a reconnect of a second or two, paid only when someone
 * actually presses something.
 *
 * The one thing that cannot be done at all is a volume *level*: there is no
 * parameter for it, so the room offers Kick a mute toggle rather than a slider.
 *
 * Playback always starts muted. An unmuted autoplay is refused by every current
 * browser, and Kick answers a refusal by drawing its own play button that the
 * room's click-lid then swallows — the same trap the Twitch engine documents.
 * Starting silent always succeeds, and the room offers the sound back.
 */
export class KickEngine implements PlayerEngine {
  readonly kind = 'kick' as const;

  #container: HTMLElement;
  #channel: string;
  #events: EngineEvents;

  #frame: HTMLIFrameElement | null = null;
  #destroyed = false;
  #ready = false;
  #announced = false;
  #unreachable: ReturnType<typeof setTimeout> | null = null;

  #playing = false;
  /**
   * Whether to load silently, decided once from the page's activation state.
   *
   * Muting guarantees the embed can start, but it costs a reload to undo — and
   * a reload is the one thing this engine cannot make cheap. So it is only paid
   * when it is actually needed: a page the viewer has already interacted with
   * has user activation, and `allow="autoplay"` passes that down to the iframe,
   * so the embed may start with sound and no reload is ever required. Someone
   * who landed on a room link and touched nothing still starts muted, because
   * for them an audible start would be refused outright.
   */
  #muted = !hasUserActivation();

  constructor(container: HTMLElement, source: MediaSource, events: EngineEvents = {}) {
    this.#container = container;
    this.#events = events;

    const channel = parseKick(source.url);
    if (!channel) {
      this.#channel = '';
      this.#events.onError?.('That Kick link is not a channel.');
      return;
    }
    this.#channel = channel;

    // Loaded straight away, like every other engine. The room holds a freshly
    // cued source until some player reports it loaded, and the only load signal
    // this embed has is its iframe arriving — so waiting for a play() that the
    // room will not send until it is ready would deadlock the two of them.
    this.#playing = true;
    this.#mount();
  }

  /**
   * Build the iframe for the current desired state.
   *
   * `autoplay` and `muted` are the entire configuration surface the embed has,
   * and both are read once at load — which is why changing either means a new
   * iframe rather than a method call.
   */
  #mount(): void {
    if (this.#destroyed || !this.#channel) return;
    this.#teardown();

    const url = new URL(`https://player.kick.com/${encodeURIComponent(this.#channel)}`);
    url.searchParams.set('autoplay', 'true');
    url.searchParams.set('muted', String(this.#muted));

    const frame = document.createElement('iframe');
    frame.src = url.toString();
    frame.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
    frame.allowFullscreen = true;
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.title = `Kick channel ${this.#channel}`;

    // Cleared by `load`. If it ever fires, the embed never arrived.
    this.#unreachable = setTimeout(() => {
      if (this.#destroyed || this.#ready) return;
      // Readiness is released alongside the error so the room stops waiting on
      // this viewer — the rest of the room should not be held up by one
      // person's network refusing to reach Kick.
      if (!this.#announced) {
        this.#announced = true;
        this.#events.onReady?.();
      }
      this.#events.onError?.(
        'Kick did not load. It may be blocked on your network — the rest of the room can carry on without you.',
      );
    }, REACHABLE_MS);

    frame.addEventListener('load', () => {
      if (this.#destroyed) return;
      this.#clearUnreachable();
      this.#ready = true;
      this.#events.onBufferingChange?.(false);

      // `load` is the only signal the iframe gives us. It means the document
      // arrived, not that video is decoding — but for a live channel with no
      // position to hold, "the player exists" is the useful readiness bar, and
      // holding the room any longer would be waiting for an event that never
      // comes. Announced once: a remount is not a new source.
      if (!this.#announced) {
        this.#announced = true;
        this.#events.onReady?.();
      }

      // Kick can only be started silently, so the room is always owed the
      // offer to turn the sound back on.
      if (this.#muted) this.#events.onAudioBlocked?.();
    });

    frame.addEventListener('error', () =>
      this.#events.onError?.('That Kick channel could not be loaded.'),
    );

    this.#container.appendChild(frame);
    this.#frame = frame;
  }

  #teardown(): void {
    this.#clearUnreachable();
    this.#frame?.remove();
    this.#frame = null;
  }

  #clearUnreachable(): void {
    if (this.#unreachable === null) return;
    clearTimeout(this.#unreachable);
    this.#unreachable = null;
  }

  currentTime(): number {
    return 0;
  }

  /** Always unknown: the embed is live-only and reports nothing. */
  duration(): null {
    return null;
  }

  /** Kick is live and nothing else, so the room never scrubs or corrects it. */
  live(): boolean {
    return true;
  }

  buffering(): boolean {
    return this.#playing && !this.#ready;
  }

  ready(): boolean {
    // A paused Kick channel has no iframe at all, but the room has still seen
    // this source load — reporting otherwise would strand the timeline.
    return this.#announced || this.#ready;
  }

  play(): void {
    if (this.#playing && this.#frame) return;
    this.#playing = true;
    this.#events.onBufferingChange?.(true);
    this.#mount();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#playing = false;
    // The room's start gate waits for some player to report the source loaded.
    // If it paused before this iframe finished loading, releasing the hold here
    // is what stops the room waiting on a player about to be removed.
    if (!this.#announced) {
      this.#announced = true;
      this.#events.onReady?.();
    }
    // Nothing short of removing the player stops the stream: there is no API
    // to pause it, and leaving it running would keep the audio going under a
    // room that believes it is paused.
    this.#teardown();
    this.#ready = false;
    this.#events.onBufferingChange?.(false);
  }

  /** Live-only: there is no position to move to. */
  seek(): void {}

  /** The embed exposes no rate control, and a live edge has no use for one. */
  setRate(): void {}

  /**
   * Not available. The embed takes no volume parameter and no volume call, so
   * the room shows Kick a mute toggle instead of a slider — doing nothing here
   * is better than reloading the stream on every drag of a control that could
   * never work.
   */
  setVolume(): void {}

  setMuted(muted: boolean): void {
    if (muted === this.#muted) return;
    this.#muted = muted;
    // Only worth a reload if something is actually playing; otherwise the next
    // play() will pick the new setting up for free.
    if (this.#playing) this.#mount();
  }

  destroy(): void {
    this.#destroyed = true;
    this.#teardown();
  }
}

/**
 * Has this page been interacted with?
 *
 * `navigator.userActivation.hasBeenActive` is the browser's own answer to the
 * question autoplay policy turns on, and it is sticky for the lifetime of the
 * document — so a viewer who clicked anything to get into the room counts.
 * Treated as "no" where the API is missing, which errs towards a silent start
 * rather than a refused one.
 */
function hasUserActivation(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.userActivation?.hasBeenActive ?? false;
}

/** `kick.com/<channel>`, already canonicalised by the server. */
export function parseKick(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.length === 1 ? (segments[0] ?? null) : null;
  } catch {
    return null;
  }
}
