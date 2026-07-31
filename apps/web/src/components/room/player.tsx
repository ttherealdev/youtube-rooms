import { positionAt } from '@youtube-room/protocol';
import {
  GripHorizontal,
  Maximize,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NoVideoIllustration } from '~/components/illustrations';
import { Button } from '~/components/ui/button';
import { Badge, EmptyState } from '~/components/ui/field';
import { cn, formatDuration } from '~/lib/utils';
import type { RoomSocket } from '~/realtime/socket';
import type { PlayerSyncHandle } from '~/realtime/use-player-sync';
import { usePermissions, useSkipVotes, useTimeline } from '~/stores/room-store';

/**
 * Drift, at a scale a person can read. Six decimal places of milliseconds says
 * nothing useful once a player is seconds out of step — and "408203ms" was how
 * a stalled player reported itself.
 */
function formatDrift(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : formatDuration(seconds);
}

/**
 * The video surface and its controls.
 *
 * The progress bar, time readout and sync badge are all driven from
 * `requestAnimationFrame` writing directly to the DOM. None of these values
 * are React state — putting a 60 Hz number in `useState` here would re-render
 * the chat log sixty times a second (ADR 0008).
 */
export function PlayerSurface({
  player,
  socket,
  mini = false,
  onMiniChange,
}: {
  player: PlayerSyncHandle;
  socket: RoomSocket | null;
  /**
   * Float the surface over the page instead of sitting in the layout.
   *
   * This is a *style* change and nothing else. The iframe keeps its place in
   * the document, which is the whole point: relocating it — as the old
   * Document-PiP path did — reloads the embed into a document with no valid
   * URL, and YouTube refuses it with error 153.
   */
  mini?: boolean;
  onMiniChange?: (mini: boolean) => void;
}) {
  const timeline = useTimeline();
  const permissions = usePermissions();
  const votes = useSkipVotes();

  const progressRef = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const remainingRef = useRef<HTMLSpanElement>(null);
  const syncRef = useRef<HTMLSpanElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);

  const [muted, setMuted] = useState(false);
  /** Offset from the bottom-right corner, in px, while floating. */
  const [miniOffset, setMiniOffset] = useState({ x: 24, y: 24 });

  /**
   * Drag the floating player by its title bar.
   *
   * The bar exists precisely because pointer events over a cross-origin iframe
   * never reach us — dragging by the video itself cannot work.
   */
  function startMiniDrag(event: React.PointerEvent<HTMLDivElement>) {
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = miniOffset;

    const onMove = (moveEvent: PointerEvent) => {
      setMiniOffset({
        x: Math.max(8, origin.x - (moveEvent.clientX - startX)),
        y: Math.max(8, origin.y - (moveEvent.clientY - startY)),
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // The imperative render loop. One rAF for the whole control bar.
  useEffect(() => {
    let frame = 0;

    const tick = () => {
      const duration = player.durationRef.current;
      const position = player.positionRef.current;

      if (duration > 0) {
        const ratio = Math.min(1, Math.max(0, position / duration));
        if (progressRef.current) {
          progressRef.current.style.transform = `scaleX(${ratio})`;
        }
        if (elapsedRef.current) {
          elapsedRef.current.textContent = formatDuration(position);
        }
        if (remainingRef.current) {
          remainingRef.current.textContent = `-${formatDuration(duration - position)}`;
        }
      }

      if (syncRef.current) {
        const signed = player.driftRef.current;
        const drift = Math.abs(signed);
        const inSync = drift < 150;
        // `drift` is `observed - target`, so a negative value means this player
        // is trailing the room and a positive one means it has run ahead.
        // Reporting the absolute value as "behind" described half of them wrong.
        syncRef.current.textContent = inSync
          ? 'in sync'
          : `${formatDrift(drift)} ${signed < 0 ? 'behind' : 'ahead'}`;
        syncRef.current.dataset.state = inSync ? 'ok' : 'drifting';
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [player]);

  const canControl = permissions?.canControlPlayback ?? false;
  const paused = timeline?.paused ?? true;
  const hasVideo = Boolean(timeline?.videoId);

  function sendIntent(action: Parameters<RoomSocket['send']>[0]) {
    socket?.send(action);
  }

  function scrub(event: React.MouseEvent<HTMLDivElement>) {
    if (!canControl || !timeline || player.durationRef.current <= 0) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const position = Math.max(0, Math.min(1, ratio)) * player.durationRef.current;

    // An intent, not a local seek: the player moves when the server's echo
    // arrives, so every participant — including this one — transitions on the
    // same authoritative record (ADR 0005 §4).
    sendIntent({
      t: 'sync_intent',
      action: { kind: 'seek', position },
      version: timeline.version,
    });
  }

  return (
    <>
      {/* Keeps the column from collapsing while the player floats. */}
      {mini ? (
        <button
          type="button"
          onClick={() => onMiniChange?.(false)}
          className={cn(
            'grid aspect-video w-full place-items-center rounded-[var(--radius-xl)]',
            'border border-dashed border-[var(--border-subtle)] bg-[var(--surface-base)]',
            'text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]',
          )}
        >
          Playing in the mini player — click to bring it back
        </button>
      ) : null}

      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-black',
          mini && 'fixed z-40 w-[min(24rem,calc(100vw-2rem))] shadow-2xl',
        )}
        style={mini ? { right: miniOffset.x, bottom: miniOffset.y } : undefined}
      >
        {mini ? (
          <div
            onPointerDown={startMiniDrag}
            className={cn(
              'flex shrink-0 cursor-grab items-center gap-2 border-b border-[var(--border-subtle)]',
              'bg-[var(--surface-raised)] px-2 py-1.5 active:cursor-grabbing',
            )}
          >
            <GripHorizontal className="size-3.5 text-[var(--text-muted)]" aria-hidden />
            <span className="truncate text-2xs text-[var(--text-muted)]">Mini player</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Return the player to the room"
              onClick={() => onMiniChange?.(false)}
            >
              <Minimize2 />
            </Button>
          </div>
        ) : null}

        <div className="relative aspect-video w-full">
          {/* The iframe mounts here; it must never unmount between videos or the
            player reloads and the room stutters. */}
          <div ref={player.containerRef} className="absolute inset-0 [&_iframe]:size-full" />

          {!hasVideo ? (
            <div className="absolute inset-0 grid place-items-center bg-[var(--surface-base)]">
              <EmptyState
                illustration={
                  <NoVideoIllustration className="size-44 text-[var(--text-primary)]" />
                }
                title="Nothing playing yet"
                description={
                  permissions?.canManageQueue
                    ? 'Paste a YouTube link in the queue to get started.'
                    : 'Waiting for the host to queue something.'
                }
              />
            </div>
          ) : null}

          {player.error ? (
            <div className="absolute inset-x-0 bottom-0 bg-danger-500/90 px-4 py-2 text-center text-xs text-white">
              {player.error}
            </div>
          ) : null}

          {player.buffering && hasVideo ? (
            <div className="absolute right-3 top-3">
              <Badge tone="neutral">Buffering…</Badge>
            </div>
          ) : null}

          {/* A transparent shield over the iframe. Without it, clicks reach
            YouTube's own controls and one person can desync the room. */}
          {hasVideo ? (
            <button
              type="button"
              className="absolute inset-0 cursor-default"
              aria-label={paused ? 'Play' : 'Pause'}
              onClick={() => {
                if (!canControl || !timeline) return;
                sendIntent({
                  t: 'sync_intent',
                  action: { kind: paused ? 'play' : 'pause' },
                  version: timeline.version,
                });
              }}
            />
          ) : null}
        </div>

        {/* Controls */}
        <div className="space-y-2 bg-[var(--surface-raised)] px-4 py-3">
          <div
            ref={scrubRef}
            onClick={scrub}
            onKeyDown={(event) => {
              if (!canControl || !timeline || !socket) return;
              const step = event.shiftKey ? 30 : 5;
              const current = positionAt(timeline, socket.clock.serverNow());
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                sendIntent({
                  t: 'sync_intent',
                  action: {
                    kind: 'seek',
                    position: Math.max(0, current + (event.key === 'ArrowRight' ? step : -step)),
                  },
                  version: timeline.version,
                });
              }
            }}
            role="slider"
            tabIndex={canControl ? 0 : -1}
            aria-label="Playback position"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={0}
            aria-disabled={!canControl}
            className={cn(
              'group relative h-4 -my-1 flex items-center',
              canControl ? 'cursor-pointer' : 'cursor-not-allowed',
            )}
          >
            <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-hover)]">
              <div
                ref={progressRef}
                className="h-full w-full origin-left rounded-full bg-[var(--accent)]"
                style={{ transform: 'scaleX(0)' }}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!canControl || !hasVideo}
              aria-label={paused ? 'Play' : 'Pause'}
              onClick={() => {
                if (!timeline) return;
                sendIntent({
                  t: 'sync_intent',
                  action: { kind: paused ? 'play' : 'pause' },
                  version: timeline.version,
                });
              }}
            >
              {paused ? <Play /> : <Pause />}
            </Button>

            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!canControl || !hasVideo}
              aria-label="Skip to next"
              onClick={() => {
                if (!timeline) return;
                sendIntent({
                  t: 'sync_intent',
                  action: { kind: 'next' },
                  version: timeline.version,
                });
              }}
            >
              <SkipForward />
            </Button>

            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={muted ? 'Unmute' : 'Mute'}
              onClick={() => {
                const next = !muted;
                setMuted(next);
                player.setVolume(next ? 0 : 100);
              }}
            >
              {muted ? <VolumeX /> : <Volume2 />}
            </Button>

            <span className="ml-1 font-mono text-2xs text-[var(--text-muted)]" data-numeric>
              <span ref={elapsedRef}>0:00</span>
              <span className="mx-1 opacity-40">/</span>
              <span ref={remainingRef}>-0:00</span>
            </span>

            <span
              ref={syncRef}
              data-state="ok"
              className={cn(
                'ml-auto font-mono text-2xs transition-colors',
                'data-[state=ok]:text-success-500 data-[state=drifting]:text-warning-500',
              )}
            >
              in sync
            </span>

            {!canControl && hasVideo ? (
              <VoteSkipButton
                votes={votes}
                onVote={(voting) => sendIntent({ t: 'skip_vote', voting })}
              />
            ) : null}

            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={mini ? 'Return the player to the room' : 'Mini player'}
              onClick={() => onMiniChange?.(!mini)}
            >
              {mini ? <Minimize2 /> : <PictureInPicture2 />}
            </Button>

            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fullscreen"
              onClick={player.requestFullscreen}
            >
              <Maximize />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function VoteSkipButton({
  votes,
  onVote,
}: {
  votes: { votes: number; needed: number; voters: string[] };
  onVote: (voting: boolean) => void;
}) {
  const [voted, setVoted] = useState(false);

  return (
    <Button
      variant={voted ? 'primary' : 'ghost'}
      size="sm"
      onClick={() => {
        onVote(!voted);
        setVoted(!voted);
      }}
    >
      Skip
      {votes.needed > 0 ? (
        <span className="font-mono text-2xs opacity-80" data-numeric>
          {votes.votes}/{votes.needed}
        </span>
      ) : null}
    </Button>
  );
}
