import { type MediaSource, mayBeLive, positionAt } from '@playercn/protocol';
import {
  Loader2,
  Maximize,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Slider } from '~/components/ui/slider';
import { cn, formatDuration } from '~/lib/utils';
import type { PlayerEngine } from '~/realtime/player/engine';
import { MediaEngine } from '~/realtime/player/media-engine';
import { YouTubeEngine } from '~/realtime/player/youtube-engine';
import type { RoomSocket } from '~/realtime/socket';
import { usePlayerSync } from '~/realtime/use-player-sync';
import { usePermissions, useTimeline } from '~/stores/room-store';

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/**
 * The room's player.
 *
 * One surface over four very different playback mechanisms. The engine is
 * rebuilt whenever the *source* changes — keyed on the URL, not on the timeline
 * object, which changes on every pause and seek — and the sync loop is what
 * keeps it on the room's position.
 *
 * Controls here send *intents*. Nothing is applied locally and then reconciled:
 * the server decides, broadcasts, and the sync loop follows. That is why
 * pressing pause in a room you cannot control does nothing visible rather than
 * pausing and then snapping back.
 */
export function Player({ socket }: { socket: RoomSocket | null }) {
  const timeline = useTimeline();
  const permissions = usePermissions();

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PlayerEngine | null>(null);

  const [engine, setEngine] = useState<PlayerEngine | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [position, setPosition] = useState(0);

  const source = timeline?.source ?? null;
  // The engine's identity is the source, not the timeline: rebuilding on every
  // pause would reload the video each time anyone touched the controls.
  const sourceKey = source ? `${source.kind}:${source.url}` : null;
  const canControl = permissions?.canControlPlayback ?? false;
  const live = source ? mayBeLive(source) : false;

  // Keyed on `sourceKey` on purpose. `source` is a fresh object on every
  // timeline update, and `canControl` changing must not tear down and reload
  // the player everyone in the room is watching.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild only on source change
  useEffect(() => {
    if (!source || !sourceKey) {
      engineRef.current?.destroy();
      engineRef.current = null;
      setEngine(null);
      return;
    }

    setError(null);
    setBuffering(true);

    const events = {
      onBufferingChange: setBuffering,
      onError: (message: string) => {
        setError(message);
        setBuffering(false);
      },
      onDurationChange: (seconds: number) => {
        // Only the room's authority learns durations for us; anyone able to
        // control playback may report, and the server keeps the first.
        if (canControl) socket?.send({ t: 'report_duration', seconds });
      },
    };

    const next: PlayerEngine =
      source.kind === 'youtube'
        ? new YouTubeEngine(mountRef.current as HTMLElement, source, events)
        : new MediaEngine(videoRef.current as HTMLVideoElement, source, events);

    engineRef.current = next;
    setEngine(next);

    return () => {
      next.destroy();
      engineRef.current = null;
    };
  }, [sourceKey, socket]);

  usePlayerSync(engine, timeline, socket);

  // Position readout, driven from the timeline rather than the player so the
  // scrubber shows where the *room* is even while a client is rebuffering.
  useEffect(() => {
    if (!timeline || !socket) return;
    const update = () => setPosition(positionAt(timeline, socket.clock.serverNow()));
    update();
    const id = setInterval(update, 250);
    return () => clearInterval(id);
  }, [timeline, socket]);

  const send = useCallback(
    (action: Parameters<RoomSocket['send']>[0] extends never ? never : SyncAction) => {
      if (!socket || !timeline) return;
      socket.send({ t: 'sync_intent', action, version: timeline.version });
    },
    [socket, timeline],
  );

  const duration = timeline?.duration ?? null;
  const paused = timeline?.paused ?? true;

  if (!source) return <IdlePlayer />;

  return (
    <div
      ref={containerRef}
      className="group relative isolate aspect-video w-full overflow-hidden rounded-xl border bg-black"
    >
      {/* Both mounts always exist so switching source kinds does not depend on
          a ref that has not been attached yet on the render the engine builds. */}
      <div
        ref={mountRef}
        className={cn('size-full', source.kind !== 'youtube' && 'hidden')}
        aria-hidden={source.kind !== 'youtube'}
      />
      {/* Captions travel inside the media — an HLS manifest carries its own
          subtitle renditions, and an MP4 its own tracks — so there is no
          separate <track> for us to author. A room plays arbitrary URLs, and
          inventing an empty track element would claim captions exist when they
          do not. */}
      {/* biome-ignore lint/a11y/useMediaCaption: captions ship inside the source */}
      <video
        ref={videoRef}
        className={cn('size-full bg-black', source.kind === 'youtube' && 'hidden')}
        playsInline
        aria-hidden={source.kind === 'youtube'}
      />

      {buffering && !error ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/30">
          <Loader2 className="size-8 animate-spin text-white/80" />
        </div>
      ) : null}

      {error ? (
        <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center">
          <div className="max-w-sm space-y-2">
            <p className="text-sm font-medium text-white">Can’t play this source</p>
            <p className="text-xs text-white/70">{error}</p>
            {canControl ? (
              <Button size="sm" variant="secondary" onClick={() => send({ kind: 'next' })}>
                Skip to next
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* A transparent lid over the YouTube iframe. Without it the iframe eats
          clicks and users control YouTube directly, desynchronising the room. */}
      <div className="absolute inset-0 bottom-16" aria-hidden />

      <div className="absolute inset-x-0 bottom-0 space-y-1.5 bg-gradient-to-t from-black/90 to-transparent p-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex items-center gap-2 text-[11px] text-white/70">
          <span data-numeric>{formatDuration(position)}</span>
          {live ? (
            <span className="flex flex-1 items-center gap-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-red-500" />
              <span className="font-medium tracking-wide text-red-400 uppercase">Live</span>
            </span>
          ) : (
            <Slider
              className="flex-1"
              value={[Math.min(position, duration ?? position)]}
              min={0}
              max={duration ?? Math.max(position, 1)}
              step={1}
              disabled={!canControl || duration === null}
              onValueChange={(value) => {
                const next = firstThumb(value);
                if (next != null) send({ kind: 'seek', position: next });
              }}
              aria-label="Seek"
            />
          )}
          <span data-numeric>{formatDuration(duration)}</span>
        </div>

        <div className="flex items-center gap-1">
          <ControlButton
            label={paused ? 'Play' : 'Pause'}
            disabled={!canControl}
            onClick={() => send({ kind: paused ? 'play' : 'pause' })}
          >
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          </ControlButton>

          <ControlButton
            label="Previous"
            disabled={!canControl}
            onClick={() => send({ kind: 'previous' })}
          >
            <SkipBack className="size-4" />
          </ControlButton>

          <ControlButton label="Next" disabled={!canControl} onClick={() => send({ kind: 'next' })}>
            <SkipForward className="size-4" />
          </ControlButton>

          <ControlButton
            label={timeline?.loop ? 'Stop looping' : 'Loop'}
            disabled={!canControl}
            onClick={() => send({ kind: 'set_loop', loop: !timeline?.loop })}
            className={timeline?.loop ? 'text-primary' : undefined}
          >
            <Repeat className="size-4" />
          </ControlButton>

          <div className="ml-1 flex items-center gap-1.5">
            <ControlButton
              label={muted ? 'Unmute' : 'Mute'}
              onClick={() => {
                const next = !muted;
                setMuted(next);
                engine?.setMuted(next);
              }}
            >
              {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </ControlButton>
            {/* Volume is purely local — it is the one control that must never
                be shared, or one person's headphones set everyone's level. */}
            <Slider
              className="w-20"
              value={[muted ? 0 : volume]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(value) => {
                const next = firstThumb(value);
                if (next == null) return;
                setVolume(next);
                setMuted(next === 0);
                engine?.setVolume(next);
                engine?.setMuted(next === 0);
              }}
              aria-label="Volume"
            />
          </div>

          <span className="flex-1" />

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canControl || live}
                  className="text-white/80 hover:bg-white/10 hover:text-white"
                >
                  {timeline?.rate ?? 1}×
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {RATES.map((rate) => (
                <DropdownMenuItem key={rate} onClick={() => send({ kind: 'set_rate', rate })}>
                  {rate}×
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <ControlButton
            label="Fullscreen"
            onClick={() => {
              const node = containerRef.current;
              if (!node) return;
              if (document.fullscreenElement) void document.exitFullscreen();
              else void node.requestFullscreen();
            }}
          >
            <Maximize className="size-4" />
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

type SyncAction =
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'seek'; position: number }
  | { kind: 'set_rate'; rate: number }
  | { kind: 'set_loop'; loop: boolean }
  | { kind: 'play_now'; queueItemId: string }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'restart' };

/**
 * Normalise a slider value.
 *
 * The primitive supports multi-thumb ranges and so reports either a number or
 * an array of them. Every slider in this player is single-thumb.
 */
function firstThumb(value: number | readonly number[]): number | undefined {
  return typeof value === 'number' ? value : value[0];
}

function ControlButton({
  label,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className={cn('text-white/85 hover:bg-white/10 hover:text-white', className)}
      {...props}
    >
      {children}
    </Button>
  );
}

function IdlePlayer() {
  return (
    <div className="grid aspect-video w-full place-items-center rounded-xl border bg-muted/30 text-center">
      <div className="space-y-1.5 px-6">
        <p className="text-sm font-medium">Nothing playing</p>
        <p className="text-xs text-muted-foreground">
          Paste a YouTube link, a video URL, a stream, or a playlist to start.
        </p>
      </div>
    </div>
  );
}

export type { MediaSource };
