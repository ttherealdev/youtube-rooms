import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { type MediaSource, mayBeLive, positionAt } from '@playercn/protocol';
import {
  Loader2,
  Maximize,
  Minimize,
  MoreVertical,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn, formatDuration } from '~/lib/utils';
import type { PlayerEngine } from '~/realtime/player/engine';
import { MediaEngine } from '~/realtime/player/media-engine';
import { YouTubeEngine } from '~/realtime/player/youtube-engine';
import type { RoomSocket } from '~/realtime/socket';
import { usePlayerSync } from '~/realtime/use-player-sync';
import { usePermissions, useQueue, useTimeline } from '~/stores/room-store';

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Skip step for the jump-back / jump-forward controls, in seconds. */
const SKIP = 10;

/** How long the chrome stays up after the pointer stops moving. */
const IDLE_MS = 2600;

/**
 * The room's player.
 *
 * One surface over four very different playback mechanisms. The engine is
 * rebuilt whenever the *source* changes — keyed on the URL, not on the timeline
 * object, which changes on every pause and seek — and the sync loop is what
 * keeps it on the room's position.
 *
 * Controls send *intents*: the server decides, broadcasts, and every player
 * follows. What makes that feel immediate rather than sluggish is that the sync
 * loop applies an incoming timeline the moment it arrives, instead of waiting
 * for its next interval tick.
 */
export function Player({
  socket,
  onEngine,
}: {
  socket: RoomSocket | null;
  /** Lifted so the room can bind keyboard shortcuts to the live engine. */
  onEngine?: (engine: PlayerEngine | null) => void;
}) {
  const timeline = useTimeline();
  const permissions = usePermissions();
  const queue = useQueue();

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
  const [scrub, setScrub] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const source = timeline?.source ?? null;
  // The engine's identity is the source, not the timeline: rebuilding on every
  // pause would reload the video each time anyone touched the controls.
  const sourceKey = source ? `${source.kind}:${source.url}` : null;
  const canControl = permissions?.canControlPlayback ?? false;
  const live = source ? mayBeLive(source) : false;
  const awaiting = timeline?.awaitingStart ?? false;
  const paused = timeline?.paused ?? true;
  const duration = timeline?.duration ?? null;

  // The engine's callbacks are bound once, when the source is built, so they
  // close over that render. A file that takes twenty seconds to buffer would
  // answer with a version the room left behind long ago — and the server
  // rejects a mismatched version — so readiness reads through a ref instead.
  const versionRef = useRef(0);
  versionRef.current = timeline?.version ?? 0;
  const canControlRef = useRef(canControl);
  canControlRef.current = canControl;

  // The timeline carries the source, not its name; the queue row it came from
  // is what has a human title.
  const nowPlaying = timeline?.queueItemId
    ? (queue.find((item) => item.id === timeline.queueItemId) ?? null)
    : null;

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
      onReady: () => {
        setBuffering(false);
        // Releases the room's hold on a freshly cued source. Sent by every
        // viewer, not only whoever can control playback: the question being
        // answered is "has this loaded anywhere", and the server keeps only
        // the first answer.
        socket?.send({ t: 'playback_ready', version: versionRef.current });
      },
      onDurationChange: (seconds: number) => {
        // Only the room's authority learns durations for us; anyone able to
        // control playback may report, and the server keeps the first.
        if (canControlRef.current) socket?.send({ t: 'report_duration', seconds });
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

  useEffect(() => {
    onEngine?.(engine);
  }, [engine, onEngine]);

  // Position readout, driven from the timeline rather than the player so the
  // scrubber shows where the *room* is even while a client is rebuffering.
  useEffect(() => {
    if (!timeline || !socket) return;
    const update = () => setPosition(positionAt(timeline, socket.clock.serverNow()));
    update();
    const id = setInterval(update, 250);
    return () => clearInterval(id);
  }, [timeline, socket]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const send = useCallback(
    (action: SyncAction) => {
      if (!socket || !timeline) return;
      socket.send({ t: 'sync_intent', action, version: timeline.version });
    },
    [socket, timeline],
  );

  const { visible, wake } = useChrome(paused || awaiting || Boolean(error));

  const toggle = useCallback(() => {
    if (!canControl) return;
    send({ kind: paused ? 'play' : 'pause' });
  }, [canControl, paused, send]);

  const seekBy = useCallback(
    (delta: number) => {
      if (!canControl) return;
      const ceiling = duration ?? position + Math.abs(delta);
      send({ kind: 'seek', position: Math.max(0, Math.min(position + delta, ceiling)) });
    },
    [canControl, position, duration, send],
  );

  const applyVolume = useCallback(
    (next: number) => {
      setVolume(next);
      setMuted(next === 0);
      engine?.setVolume(next);
      engine?.setMuted(next === 0);
    },
    [engine],
  );

  if (!source) return <IdlePlayer />;

  const shown = scrub ?? position;
  const progress = duration && duration > 0 ? Math.min(1, shown / duration) : 0;

  return (
    <div
      ref={containerRef}
      onPointerMove={() => wake()}
      onPointerLeave={() => wake(false)}
      className={cn(
        'group/player relative isolate aspect-video w-full overflow-hidden rounded-xl bg-black select-none',
        !visible && 'cursor-none',
      )}
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
          separate <track> for us to author. */}
      {/* biome-ignore lint/a11y/useMediaCaption: captions ship inside the source */}
      <video
        ref={videoRef}
        className={cn('size-full bg-black', source.kind === 'youtube' && 'hidden')}
        playsInline
        aria-hidden={source.kind === 'youtube'}
      />

      {/* Click target over the picture. It sits *under* the control bar, and
          for YouTube it doubles as the lid that stops the iframe eating clicks
          and letting one person drive their own player out of sync. */}
      <button
        type="button"
        onClick={toggle}
        onDoubleClick={() => toggleFullscreen(containerRef.current)}
        disabled={!canControl}
        aria-label={paused ? 'Play' : 'Pause'}
        className="absolute inset-0 z-10 cursor-default disabled:cursor-default"
      />

      <StatusOverlay
        awaiting={awaiting}
        buffering={buffering}
        error={error}
        paused={paused}
        canControl={canControl}
        onSkip={() => send({ kind: 'next' })}
      />

      <div
        className={cn(
          'absolute inset-x-0 bottom-0 z-20 flex flex-col gap-3 px-4 pt-16 pb-3 sm:px-6 sm:pb-4',
          'bg-gradient-to-t from-black/85 via-black/45 to-transparent',
          'transition-opacity duration-200',
          visible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white sm:text-base">
              {nowPlaying?.title ?? titleFromSource(source)}
            </p>
            <p className="truncate text-xs text-white/70">
              {describeState({ awaiting, buffering, live, source, nowPlaying })}
            </p>
          </div>

          {live ? (
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-red-500" />
              <span className="text-xs font-medium tracking-wide text-red-400 uppercase">Live</span>
            </span>
          ) : (
            <span className="shrink-0 text-xs text-white/90" data-numeric>
              {formatDuration(shown)} / {formatDuration(duration)}
            </span>
          )}
        </div>

        {live ? (
          <div className="h-[3px] w-full rounded-full bg-white/40" />
        ) : (
          <SeekBar
            value={shown}
            max={duration ?? Math.max(shown, 1)}
            progress={progress}
            disabled={!canControl || duration === null}
            onScrub={setScrub}
            onCommit={(next) => {
              setScrub(null);
              send({ kind: 'seek', position: next });
            }}
          />
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-0.5 sm:gap-1">
            <ControlButton
              label={paused ? 'Play' : 'Pause'}
              disabled={!canControl}
              onClick={toggle}
            >
              {paused ? (
                <Play className="size-5 fill-current" />
              ) : (
                <Pause className="size-5 fill-current" />
              )}
            </ControlButton>

            <ControlButton
              label={`Back ${SKIP} seconds`}
              disabled={!canControl || live}
              onClick={() => seekBy(-SKIP)}
            >
              <RotateCcw className="size-5" />
            </ControlButton>

            <ControlButton
              label={`Forward ${SKIP} seconds`}
              disabled={!canControl || live}
              onClick={() => seekBy(SKIP)}
            >
              <RotateCw className="size-5" />
            </ControlButton>

            <ControlButton
              label="Previous"
              disabled={!canControl}
              onClick={() => send({ kind: 'previous' })}
            >
              <SkipBack className="size-5" />
            </ControlButton>

            <ControlButton
              label="Next"
              disabled={!canControl}
              onClick={() => send({ kind: 'next' })}
            >
              <SkipForward className="size-5" />
            </ControlButton>
          </div>

          <div className="flex items-center gap-0.5 sm:gap-1">
            <LoopButton
              looping={timeline?.loop ?? false}
              disabled={!canControl}
              onToggle={(next) => {
                send({ kind: 'set_loop', loop: next });
                toast.success(
                  next
                    ? 'Repeating this video — it will replay when it ends.'
                    : 'Repeat off — the room moves on to the next item.',
                );
              }}
            />

            <VolumeControl
              muted={muted}
              volume={volume}
              onMute={() => {
                const next = !muted;
                setMuted(next);
                engine?.setMuted(next);
              }}
              onVolume={applyVolume}
            />

            {live ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canControl}
                      aria-label="Playback speed"
                      className="h-9 min-w-9 px-2 text-xs font-medium text-white hover:bg-white/15 hover:text-white"
                    >
                      {timeline?.rate ?? 1}×
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Playback speed</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {RATES.map((rate) => (
                    <DropdownMenuItem key={rate} onClick={() => send({ kind: 'set_rate', rate })}>
                      {rate}×{rate === (timeline?.rate ?? 1) ? ' ·' : ''}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <ControlButton
              label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              onClick={() => toggleFullscreen(containerRef.current)}
            >
              {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
            </ControlButton>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="More"
                    className="size-9 text-white hover:bg-white/15 hover:text-white"
                  >
                    <MoreVertical className="size-5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    void navigator.clipboard.writeText(source.url);
                    toast.success('Source URL copied');
                  }}
                >
                  Copy source URL
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canControl} onClick={() => send({ kind: 'restart' })}>
                  Restart from the beginning
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
 * The auto-hiding chrome.
 *
 * Held open whenever the room is not actually playing. A paused player with
 * hidden controls is the most reliable way to make a video player feel broken,
 * because the only affordance for fixing it is invisible.
 */
function useChrome(pinned: boolean): { visible: boolean; wake: (active?: boolean) => void } {
  const [awake, setAwake] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = useCallback((active = true) => {
    if (timer.current) clearTimeout(timer.current);
    if (!active) {
      setAwake(false);
      return;
    }
    setAwake(true);
    timer.current = setTimeout(() => setAwake(false), IDLE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return { visible: pinned || awake, wake };
}

/**
 * The seek bar from the reference design: a thin rule that thickens under the
 * pointer, with the handle appearing only once you are aiming at it.
 */
function SeekBar({
  value,
  max,
  progress,
  disabled,
  onScrub,
  onCommit,
}: {
  value: number;
  max: number;
  progress: number;
  disabled: boolean;
  onScrub: (value: number | null) => void;
  onCommit: (value: number) => void;
}) {
  return (
    <SliderPrimitive.Root
      value={[Math.min(value, max)]}
      min={0}
      max={max}
      step={0.5}
      disabled={disabled}
      thumbAlignment="edge"
      aria-label="Seek"
      onValueChange={(next) => onScrub(firstThumb(next) ?? null)}
      onValueCommitted={(next) => {
        const committed = firstThumb(next);
        if (committed != null) onCommit(committed);
      }}
      className="group/seek w-full"
    >
      <SliderPrimitive.Control className="relative flex h-3 w-full touch-none items-center select-none data-disabled:opacity-60">
        <SliderPrimitive.Track className="relative h-[3px] w-full grow overflow-hidden rounded-full bg-white/40 transition-[height] group-hover/seek:h-[5px]">
          {/* Driven by the derived progress rather than the primitive's own
              indicator, so the fill cannot disagree with the readout above it. */}
          <div
            className="h-full rounded-full bg-white"
            style={{ width: `${Math.round(progress * 1000) / 10}%` }}
          />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="relative block size-3 shrink-0 rounded-full bg-white opacity-0 shadow transition-opacity after:absolute after:-inset-2 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-white/70 group-hover/seek:opacity-100" />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

/**
 * Loop, with the ambiguity removed.
 *
 * The old control was a bare repeat glyph toggling something invisible: no
 * label, no state, and no way to tell whether it looped the video, the queue,
 * or nothing at all. It loops the *current video* — the server restarts it in
 * place when it ends — so the icon, the tooltip and the toast all say so.
 */
function LoopButton({
  looping,
  disabled,
  onToggle,
}: {
  looping: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-pressed={looping}
            aria-label={looping ? 'Stop repeating this video' : 'Repeat this video'}
            onClick={() => onToggle(!looping)}
            className={cn(
              'size-9 text-white hover:bg-white/15 hover:text-white',
              looping && 'bg-white/20 text-white hover:bg-white/25',
            )}
          >
            {looping ? <Repeat1 className="size-5" /> : <Repeat className="size-5" />}
          </Button>
        }
      />
      <TooltipContent>
        {looping ? 'Repeating this video' : 'Repeat this video when it ends'}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Volume is purely local — it is the one control that must never be shared, or
 * one person's headphones set the level for everybody in the room.
 */
function VolumeControl({
  muted,
  volume,
  onMute,
  onVolume,
}: {
  muted: boolean;
  volume: number;
  onMute: () => void;
  onVolume: (value: number) => void;
}) {
  const Icon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="group/volume flex items-center">
      <ControlButton label={muted ? 'Unmute' : 'Mute'} onClick={onMute}>
        <Icon className="size-5" />
      </ControlButton>
      <div className="w-0 overflow-hidden transition-[width] group-focus-within/volume:w-20 group-hover/volume:w-20">
        <SliderPrimitive.Root
          value={[muted ? 0 : volume]}
          min={0}
          max={1}
          step={0.05}
          thumbAlignment="edge"
          aria-label="Volume"
          onValueChange={(next) => {
            const value = firstThumb(next);
            if (value != null) onVolume(value);
          }}
          className="w-20 px-1.5"
        >
          <SliderPrimitive.Control className="relative flex h-8 w-full touch-none items-center select-none">
            <SliderPrimitive.Track className="relative h-[3px] w-full grow overflow-hidden rounded-full bg-white/40">
              <SliderPrimitive.Indicator className="h-full rounded-full bg-white" />
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb className="relative block size-2.5 shrink-0 rounded-full bg-white after:absolute after:-inset-2" />
          </SliderPrimitive.Control>
        </SliderPrimitive.Root>
      </div>
    </div>
  );
}

/**
 * Everything that can be true of the picture instead of a picture: waiting for
 * the room to start, rebuffering, failed, or simply paused.
 */
function StatusOverlay({
  awaiting,
  buffering,
  error,
  paused,
  canControl,
  onSkip,
}: {
  awaiting: boolean;
  buffering: boolean;
  error: string | null;
  paused: boolean;
  canControl: boolean;
  onSkip: () => void;
}) {
  if (error) {
    return (
      <div className="absolute inset-0 z-30 grid place-items-center bg-black/85 p-6 text-center">
        <div className="max-w-sm space-y-2">
          <p className="text-sm font-medium text-white">Can’t play this source</p>
          <p className="text-xs text-white/70">{error}</p>
          {canControl ? (
            <Button size="sm" variant="secondary" onClick={onSkip} className="mt-2">
              Skip to next
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (awaiting || buffering) {
    return (
      <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/25">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="size-8 animate-spin text-white/90" />
          {awaiting ? <p className="text-xs text-white/80">Waiting for everyone to load…</p> : null}
        </div>
      </div>
    );
  }

  if (!paused) return null;

  // A paused room gets an unmissable target. This is the affordance the old
  // player hid behind a hover-only bar.
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
      <span className="grid size-16 place-items-center rounded-full bg-black/55 backdrop-blur-sm">
        <Play className="size-7 fill-white text-white" />
      </span>
    </div>
  );
}

function ControlButton({
  label,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className={cn(
              'size-9 text-white hover:bg-white/15 hover:text-white disabled:opacity-40',
              className,
            )}
            {...props}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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

function toggleFullscreen(node: HTMLElement | null): void {
  if (!node) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void node.requestFullscreen().catch(() => undefined);
}

/**
 * Normalise a slider value.
 *
 * The primitive supports multi-thumb ranges and so reports either a number or
 * an array of them. Every slider in this player is single-thumb.
 */
function firstThumb(value: number | readonly number[]): number | undefined {
  return typeof value === 'number' ? value : value[0];
}

/** A usable name for a source the queue could not name for us. */
function titleFromSource(source: MediaSource): string {
  if (source.kind === 'youtube') return 'YouTube video';
  try {
    const { pathname, hostname } = new URL(source.url);
    const file = pathname.split('/').filter(Boolean).pop();
    return file ? decodeURIComponent(file) : hostname;
  } catch {
    return 'Now playing';
  }
}

function describeState({
  awaiting,
  buffering,
  live,
  source,
  nowPlaying,
}: {
  awaiting: boolean;
  buffering: boolean;
  live: boolean;
  source: MediaSource;
  nowPlaying: { channelTitle: string } | null;
}): string {
  if (awaiting) return 'Waiting for everyone to load…';
  if (buffering) return 'Buffering…';
  if (nowPlaying?.channelTitle) return nowPlaying.channelTitle;
  if (live) return 'Live stream';
  try {
    return new URL(source.url).hostname;
  } catch {
    return source.kind.toUpperCase();
  }
}

export type { MediaSource };
