import { type ClientMessage, positionAt } from '@playercn/protocol';
import { useEffect } from 'react';
import type { PlayerEngine } from '~/realtime/player/engine';
import type { RoomSocket } from '~/realtime/socket';
import { usePermissions, useTimeline } from '~/stores/room-store';

/**
 * Keyboard control for the room.
 *
 * Two rules shape everything here:
 *
 * 1. **Playback keys send intents, never local seeks.** Pressing `l` does not
 *    move this player — it asks the server, and every participant transitions
 *    on the same authoritative record (ADR 0005 §4). A shortcut that moved the
 *    local player directly would silently desync the room.
 * 2. **A shortcut must never eat a keystroke meant for text.** Typing "queue"
 *    in the chat box must not toggle a panel, so anything originating in an
 *    editable field is ignored before it is matched.
 */

export interface RoomShortcutActions {
  focusChat: () => void;
  focusSearch: () => void;
  showPanel: (panel: 'chat' | 'queue' | 'people') => void;
  toggleHelp: () => void;
  requestFullscreen: () => void;
  toggleTheatre: () => void;
}

type SyncAction = Extract<ClientMessage, { t: 'sync_intent' }>['action'];

/** Seek distances, matching what people already expect from YouTube. */
const SEEK_SMALL = 5;
const SEEK_LARGE = 10;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useRoomShortcuts({
  socket,
  engine,
  actions,
  enabled = true,
}: {
  socket: RoomSocket | null;
  engine: PlayerEngine | null;
  actions: RoomShortcutActions;
  enabled?: boolean;
}): void {
  const timeline = useTimeline();
  const permissions = usePermissions();

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      // Browser and OS bindings win. Without this, Ctrl+F and Cmd+L stop
      // working the moment the room is open.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const canControl = permissions?.canControlPlayback ?? false;
      const hasVideo = Boolean(timeline?.source);

      /**
       * Ask the server to move playback. Returns whether the request was
       * actually sent, so the caller only swallows the keystroke when it did
       * something — an unprivileged guest keeps normal browser behaviour.
       */
      const intent = (action: SyncAction): boolean => {
        if (!socket || !timeline || !canControl || !hasVideo) return false;
        socket.send({ t: 'sync_intent', action, version: timeline.version });
        return true;
      };

      const seekBy = (delta: number) => {
        if (!timeline || !socket) return false;
        // Relative to where the *room* is, not to where this player happens to
        // be. A client mid-rebuffer would otherwise drag everyone back with it.
        const from = positionAt(timeline, socket.clock.serverNow());
        return intent({ kind: 'seek', position: Math.max(0, from + delta) });
      };

      // `event.key` rather than `code`, so the bindings follow the user's
      // layout instead of assuming QWERTY.
      const key = event.key;

      // Digits scrub proportionally: 0 is the start, 9 is 90% in.
      if (key >= '0' && key <= '9' && !event.shiftKey) {
        const duration = timeline?.duration ?? 0;
        if (duration > 0 && intent({ kind: 'seek', position: duration * (Number(key) / 10) })) {
          event.preventDefault();
        }
        return;
      }

      switch (key) {
        // --- Playback ------------------------------------------------------
        case ' ':
        case 'k':
        case 'K':
          // Space also scrolls the page, so it must be swallowed even when the
          // press is refused for lack of permission.
          event.preventDefault();
          intent({ kind: timeline?.paused ? 'play' : 'pause' });
          return;

        case 'ArrowRight':
          if (seekBy(SEEK_SMALL)) event.preventDefault();
          return;
        case 'ArrowLeft':
          if (seekBy(-SEEK_SMALL)) event.preventDefault();
          return;
        case 'l':
        case 'L':
          seekBy(SEEK_LARGE);
          return;
        case 'j':
        case 'J':
          seekBy(-SEEK_LARGE);
          return;

        case 'n':
        case 'N':
          intent({ kind: 'next' });
          return;
        case 'p':
        case 'P':
          intent({ kind: 'previous' });
          return;

        // --- Local, and therefore always allowed ---------------------------
        // Volume, fullscreen and panel state are this browser's business; they
        // are not part of the shared timeline, so they work for guests too.
        case 'm':
        case 'M':
          engine?.setMuted(true);
          return;

        case 'f':
        case 'F':
          actions.requestFullscreen();
          return;

        case 't':
        case 'T':
          actions.toggleTheatre();
          return;

        // --- Panels --------------------------------------------------------
        case 'c':
        case 'C':
          event.preventDefault();
          actions.showPanel('chat');
          actions.focusChat();
          return;

        case 'q':
        case 'Q':
          actions.showPanel('queue');
          return;

        case 'u':
        case 'U':
          actions.showPanel('people');
          return;

        case '/':
          // Chrome's quick-find would otherwise steal this.
          event.preventDefault();
          actions.showPanel('queue');
          actions.focusSearch();
          return;

        case '?':
          event.preventDefault();
          actions.toggleHelp();
          return;

        default:
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, socket, timeline, permissions, engine, actions]);
}

/** The bindings, in the order the help overlay lists them. */
export const SHORTCUTS: ReadonlyArray<{
  group: string;
  items: ReadonlyArray<{ keys: string[]; label: string; hostOnly?: boolean }>;
}> = [
  {
    group: 'Playback',
    items: [
      { keys: ['Space', 'K'], label: 'Play / pause', hostOnly: true },
      { keys: ['←', '→'], label: `Seek ${SEEK_SMALL}s`, hostOnly: true },
      { keys: ['J', 'L'], label: `Seek ${SEEK_LARGE}s`, hostOnly: true },
      { keys: ['0', '–', '9'], label: 'Jump to 0–90%', hostOnly: true },
      { keys: ['N', 'P'], label: 'Next / previous', hostOnly: true },
    ],
  },
  {
    group: 'This browser',
    items: [
      { keys: ['M'], label: 'Mute' },
      { keys: ['F'], label: 'Fullscreen' },
    ],
  },
  {
    group: 'Panels',
    items: [
      { keys: ['C'], label: 'Chat' },
      { keys: ['Q'], label: 'Queue' },
      { keys: ['U'], label: 'People' },
      { keys: ['/'], label: 'Search the queue' },
      { keys: ['?'], label: 'This list' },
    ],
  },
];
