import type { MediaSource } from '@playercn/protocol';
import type { EngineEvents, PlayerEngine } from './engine';

/**
 * The Kick adapter.
 *
 * Kick publishes an embeddable player but no JavaScript API for it, so unlike
 * every other engine here this one cannot be *driven*: there is no supported
 * way to play, pause, seek or set the volume from outside the iframe. Viewers
 * use the player's own controls.
 *
 * That is a smaller loss than it sounds. Kick is live-only — no VODs are
 * addressable through the embed — so there is no position to synchronise and
 * nothing for the room's timeline to correct. Everyone watching a Kick channel
 * is already at the live edge by definition, which is the same guarantee the
 * sync loop provides for everything else.
 *
 * The transport methods are therefore deliberate no-ops rather than errors: the
 * sync loop calls them every tick, and throwing would abort it.
 */
export class KickEngine implements PlayerEngine {
  readonly kind = 'kick' as const;

  #frame: HTMLIFrameElement | null = null;
  #events: EngineEvents;
  #destroyed = false;
  #ready = false;

  constructor(container: HTMLElement, source: MediaSource, events: EngineEvents = {}) {
    this.#events = events;

    const channel = parseKick(source.url);
    if (!channel) {
      this.#events.onError?.('That Kick link is not a channel.');
      return;
    }

    const frame = document.createElement('iframe');
    frame.src = `https://player.kick.com/${encodeURIComponent(channel)}`;
    frame.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
    frame.allowFullscreen = true;
    frame.style.width = '100%';
    frame.style.height = '100%';
    frame.style.border = '0';
    frame.title = `Kick channel ${channel}`;

    frame.addEventListener('load', () => {
      if (this.#destroyed) return;
      this.#ready = true;
      // `load` is the only signal the iframe gives us. It means the document
      // arrived, not that video is decoding — but for a live channel with no
      // position to hold, "the player exists" is the useful readiness bar, and
      // holding the room any longer would be waiting for an event that never
      // comes.
      this.#events.onReady?.();
      this.#events.onBufferingChange?.(false);
    });

    frame.addEventListener('error', () =>
      this.#events.onError?.('That Kick channel could not be loaded.'),
    );

    container.appendChild(frame);
    this.#frame = frame;
  }

  currentTime(): number {
    return 0;
  }

  /** Always unknown: the embed is live-only and reports nothing. */
  duration(): null {
    return null;
  }

  buffering(): boolean {
    return !this.#ready;
  }

  ready(): boolean {
    return this.#ready;
  }

  // No API to drive. See the note on the class.
  play(): void {}
  pause(): void {}
  seek(): void {}
  setRate(): void {}
  setVolume(): void {}
  setMuted(): void {}

  destroy(): void {
    this.#destroyed = true;
    this.#frame?.remove();
    this.#frame = null;
  }
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
