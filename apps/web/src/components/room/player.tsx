import { positionAt } from '@youtube-room/protocol';
import {
  Maximize,
  Pause,
  PictureInPicture2,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { NoVideoIllustration } from '~/components/illustrations';
import { Button } from '~/components/ui/button';
import { Badge, EmptyState } from '~/components/ui/field';
import { cn, formatDuration } from '~/lib/utils';
import type { RoomSocket } from '~/realtime/socket';
import type { PlayerSyncHandle } from '~/realtime/use-player-sync';
import { usePermissions, useSkipVotes, useTimeline } from '~/stores/room-store';

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
}: {
  player: PlayerSyncHandle;
  socket: RoomSocket | null;
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
        const drift = Math.abs(player.driftRef.current);
        const inSync = drift < 150;
        syncRef.current.textContent = inSync ? 'in sync' : `${Math.round(drift)}ms behind`;
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
    <div className="flex flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-black">
      <div className="relative aspect-video w-full">
        {/* The iframe mounts here; it must never unmount between videos or the
            player reloads and the room stutters. */}
        <div ref={player.containerRef} className="absolute inset-0 [&_iframe]:size-full" />

        {!hasVideo ? (
          <div className="absolute inset-0 grid place-items-center bg-[var(--surface-base)]">
            <EmptyState
              illustration={<NoVideoIllustration className="size-44 text-[var(--text-primary)]" />}
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
              sendIntent({ t: 'sync_intent', action: { kind: 'next' }, version: timeline.version });
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
            aria-label="Picture in picture"
            onClick={() => {
              player.requestPictureInPicture().catch((cause: unknown) => {
                toast.error(
                  cause instanceof Error ? cause.message : 'Picture-in-picture is unavailable.',
                );
              });
            }}
          >
            <PictureInPicture2 />
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
