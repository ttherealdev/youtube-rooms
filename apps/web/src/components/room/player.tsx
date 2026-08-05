import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { type MediaSource, mayBeLive, positionAt } from "@playercn/protocol";
import {
  Check,
  Copy,
  Frame,
  Gauge,
  Maximize,
  Minimize,
  MoreHorizontal,
  Pause,
  PictureInPicture2,
  Play,
  RectangleHorizontal,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn, formatDuration } from "~/lib/utils";
import type { PlayerEngine } from "~/realtime/player/engine";
import { KickEngine } from "~/realtime/player/kick-engine";
import { MediaEngine } from "~/realtime/player/media-engine";
import { TwitchEngine } from "~/realtime/player/twitch-engine";
import { YouTubeEngine } from "~/realtime/player/youtube-engine";
import type { RoomSocket } from "~/realtime/socket";
import { usePlayerSync } from "~/realtime/use-player-sync";
import { usePermissions, useQueue, useTimeline } from "~/stores/room-store";

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Skip step for the jump-back / jump-forward controls, in seconds. */
const SKIP = 10;

/** Source kinds that draw into a third-party iframe rather than a `<video>`. */
const EMBEDDED_KINDS = new Set<MediaSource["kind"]>([
  "youtube",
  "twitch",
  "kick",
]);

/** How long the chrome stays up after the pointer stops moving (desktop). */
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
 *
 * The chrome below the picture is two different layouts sharing one state
 * machine, not one layout squeezed to fit. Desktop has room for every control
 * inline with hover affordances; a phone does not, so touch gets four primary
 * actions and a "More" sheet for everything else, with a volume popover
 * instead of a hover-reveal slider nothing on touch can hover.
 */
export function Player({
  socket,
  onEngine,
  theatre = false,
  onTheatre,
}: {
  socket: RoomSocket | null;
  /** Lifted so the room can bind keyboard shortcuts to the live engine. */
  onEngine?: (engine: PlayerEngine | null) => void;
  /** Owned by the room, because it is the room's layout that changes. */
  theatre?: boolean;
  onTheatre?: () => void;
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
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [position, setPosition] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // Discovered by the engine rather than implied by the URL: a YouTube link is
  // an ordinary video right up until it is a 24/7 broadcast.
  const [engineLive, setEngineLive] = useState(false);
  const [qualities, setQualities] = useState<string[]>([]);
  const [quality, setQuality] = useState<string | null>(null);
  // The browser refused an audible start, so the engine went silent to get
  // playing at all. The room owes the viewer a way to turn the sound back on.
  const [audioBlocked, setAudioBlocked] = useState(false);

  const source = timeline?.source ?? null;
  // The engine's identity is the source, not the timeline: rebuilding on every
  // pause would reload the video each time anyone touched the controls.
  const sourceKey = source ? `${source.kind}:${source.url}` : null;
  const canControl = permissions?.canControlPlayback ?? false;
  const live = (source ? mayBeLive(source) : false) || engineLive;
  // Which of the two mounts this source draws into: a third-party iframe, or
  // the plain media element.
  const embedded = source ? EMBEDDED_KINDS.has(source.kind) : false;
  // Kick's embed takes no volume parameter and no volume call, so it gets a
  // mute toggle instead of a slider rather than a slider that does nothing.
  const hasVolume = source?.kind !== "kick";
  const awaiting = timeline?.awaitingStart ?? false;
  const paused = timeline?.paused ?? true;
  const duration = timeline?.duration ?? null;

  const versionRef = useRef(0);
  versionRef.current = timeline?.version ?? 0;
  const canControlRef = useRef(canControl);
  canControlRef.current = canControl;

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
    setEngineLive(false);
    setQualities([]);
    setQuality(null);
    setAudioBlocked(false);

    const events = {
      onBufferingChange: setBuffering,
      onError: (message: string) => {
        setError(message);
        setBuffering(false);
      },
      onReady: () => {
        setBuffering(false);
        socket?.send({ t: "playback_ready", version: versionRef.current });
      },
      onLive: () => setEngineLive(true),
      onAudioBlocked: () => {
        setAudioBlocked(true);
        setMuted(true);
      },
      onQualitiesChange: () => {
        setQualities(engineRef.current?.qualities?.() ?? []);
        setQuality(engineRef.current?.quality?.() ?? null);
      },
      onDurationChange: (seconds: number) => {
        if (canControlRef.current)
          socket?.send({ t: "report_duration", seconds });
      },
    };

    const mount = mountRef.current as HTMLElement;
    const next: PlayerEngine =
      source.kind === "youtube"
        ? new YouTubeEngine(mount, source, events)
        : source.kind === "twitch"
          ? new TwitchEngine(mount, source, events)
          : source.kind === "kick"
            ? new KickEngine(mount, source, events)
            : new MediaEngine(
                videoRef.current as HTMLVideoElement,
                source,
                events,
              );

    engineRef.current = next;
    setEngine(next);

    return () => {
      next.destroy();
      engineRef.current = null;
      mount.replaceChildren();
    };
  }, [sourceKey, socket]);

  usePlayerSync(engine, timeline, socket);

  useEffect(() => {
    onEngine?.(engine);
  }, [engine, onEngine]);

  useEffect(() => {
    if (!timeline || !socket) return;
    const update = () =>
      setPosition(positionAt(timeline, socket.clock.serverNow()));
    update();
    const id = setInterval(update, 250);
    return () => clearInterval(id);
  }, [timeline, socket]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const send = useCallback(
    (action: SyncAction) => {
      if (!socket || !timeline) return;
      socket.send({ t: "sync_intent", action, version: timeline.version });
    },
    [socket, timeline],
  );

  const { visible, wake, tap } = useChrome(
    paused || awaiting || Boolean(error),
  );

  const toggle = useCallback(() => {
    if (!canControl) return;
    send({ kind: paused ? "play" : "pause" });
  }, [canControl, paused, send]);

  const seekBy = useCallback(
    (delta: number) => {
      if (!canControl) return;
      const ceiling = duration ?? position + Math.abs(delta);
      send({
        kind: "seek",
        position: Math.max(0, Math.min(position + delta, ceiling)),
      });
    },
    [canControl, position, duration, send],
  );

  const applyVolume = useCallback(
    (next: number) => {
      setVolume(next);
      setMuted(next === 0);
      engine?.setVolume(next);
      engine?.setMuted(next === 0);
      if (next > 0) setAudioBlocked(false);
    },
    [engine],
  );

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    engine?.setMuted(next);
    if (!next) setAudioBlocked(false);
  }, [engine, muted]);

  /**
   * Take the browser up on its offer.
   *
   * Autoplay policy only refuses playback that no gesture asked for, so this
   * handler — running inside a real click — is the one moment unmuting is
   * allowed. Kick reloads its iframe to do it; everything else just unmutes.
   */
  const restoreAudio = useCallback(() => {
    setAudioBlocked(false);
    setMuted(false);
    if (volume === 0) setVolume(1);
    engine?.setVolume(volume === 0 ? 1 : volume);
    engine?.setMuted(false);
    void engine?.play();
  }, [engine, volume]);

  const applyQuality = useCallback(
    (next: string | null) => {
      setQuality(next);
      engine?.setQuality?.(next);
    },
    [engine],
  );

  const copyLink = useCallback(() => {
    void navigator.clipboard.writeText(source?.url ?? "");
    toast.success("Source URL copied");
  }, [source]);

  const toggleLoop = useCallback(
    (next: boolean) => {
      send({ kind: "set_loop", loop: next });
      toast.success(
        next
          ? "Repeating this video — it will replay when it ends."
          : "Repeat off — the room moves on to the next item.",
      );
    },
    [send],
  );

  if (!source) return <IdlePlayer />;

  const shown = scrub ?? position;
  const progress = duration && duration > 0 ? Math.min(1, shown / duration) : 0;
  const canPip =
    !embedded &&
    typeof document !== "undefined" &&
    document.pictureInPictureEnabled;

  const player = (
    <div
      ref={containerRef}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch") wake();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") wake(false);
      }}
      className={cn(
        "group/player relative isolate aspect-video w-full overflow-hidden bg-black select-none",
        // In theatre mode the sizing is owned by the centring wrapper below,
        // so the box itself only needs to stay a 16:9 rectangle that never
        // exceeds it. Outside theatre it is a rounded card in a column.
        theatre ? "max-h-full max-w-full" : "rounded-xl",
        !visible && "cursor-none",
      )}
    >
      {/* Both mounts always exist so switching source kinds does not depend on
          a ref that has not been attached yet on the render the engine builds. */}
      <div
        ref={mountRef}
        className={cn("size-full", !embedded && "hidden")}
        aria-hidden={!embedded}
      />
      {/* biome-ignore lint/a11y/useMediaCaption: captions ship inside the source */}
      <video
        ref={videoRef}
        className={cn("size-full bg-black", embedded && "hidden")}
        playsInline
        aria-hidden={embedded}
      />

      {/* Click/tap target over the picture. On a mouse it toggles play; on
          touch it only wakes the chrome, because a thumb's first tap on a
          hidden control bar should never also cost a play/pause it couldn't
          see coming. */}
      <button
        type="button"
        onClick={(event) => {
          if (event.detail === 0) return; // ignore synthetic activation after a touch tap
          toggle();
        }}
        onPointerUp={(event) => {
          if (event.pointerType !== "touch") return;
          if (!visible) {
            tap();
            return;
          }
          toggle();
        }}
        onDoubleClick={() => toggleFullscreen(containerRef.current)}
        disabled={!canControl}
        aria-label={paused ? "Play" : "Pause"}
        className="absolute inset-0 z-10 cursor-default disabled:cursor-default"
      />

      <StatusOverlay
        awaiting={awaiting}
        buffering={buffering}
        error={error}
        paused={paused}
        canControl={canControl}
        poster={posterFor(source, nowPlaying?.thumbnailUrl)}
        onSkip={() => send({ kind: "next" })}
      />

      {audioBlocked && !paused ? (
        <UnmuteOverlay onUnmute={restoreAudio} />
      ) : null}

      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 px-3 pt-14 pb-2.5 sm:gap-3 sm:px-6 sm:pt-16 sm:pb-4",
          "bg-gradient-to-t from-black/90 via-black/50 to-transparent",
          "transition-opacity duration-200",
          visible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-white sm:text-base">
              {nowPlaying?.title ?? titleFromSource(source)}
            </p>
            <p className="truncate text-[11px] text-white/70 sm:text-xs">
              {describeState({ awaiting, buffering, live, source, nowPlaying })}
            </p>
          </div>

          {live ? (
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="size-1.5 animate-pulse rounded-full bg-red-500" />
              <span className="text-[11px] font-medium tracking-wide text-red-400 uppercase sm:text-xs">
                Live
              </span>
            </span>
          ) : (
            <span
              className="shrink-0 text-[11px] text-white/90 sm:text-xs"
              data-numeric
            >
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
              send({ kind: "seek", position: next });
            }}
          />
        )}

        {/* Desktop: every control inline. */}
        <div className="hidden items-center justify-between gap-2 sm:flex">
          <div className="flex items-center gap-0.5">
            <ControlButton
              label={paused ? "Play" : "Pause"}
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
              onClick={() => send({ kind: "previous" })}
            >
              <SkipBack className="size-5" />
            </ControlButton>
            <ControlButton
              label="Next"
              disabled={!canControl}
              onClick={() => send({ kind: "next" })}
            >
              <SkipForward className="size-5" />
            </ControlButton>
          </div>

          <div className="flex items-center gap-0.5">
            <LoopButton
              looping={timeline?.loop ?? false}
              disabled={!canControl}
              onToggle={toggleLoop}
            />

            <VolumeControl
              muted={muted}
              volume={volume}
              slider={hasVolume}
              open={volumeOpen}
              onOpenChange={setVolumeOpen}
              onMute={toggleMute}
              onVolume={applyVolume}
            />

            {qualities.length > 1 ? (
              <QualityMenu
                qualities={qualities}
                quality={quality}
                onSelect={applyQuality}
              />
            ) : null}

            {live ? null : (
              <RateMenu
                rate={timeline?.rate ?? 1}
                onSelect={(rate) => send({ kind: "set_rate", rate })}
              />
            )}

            {onTheatre ? (
              <ControlButton
                label={theatre ? "Exit theatre mode" : "Theatre mode"}
                aria-pressed={theatre}
                onClick={onTheatre}
                className={cn(theatre && "bg-white/20 hover:bg-white/25")}
              >
                {theatre ? (
                  <RectangleHorizontal className="size-5" />
                ) : (
                  <Frame className="size-5" />
                )}
              </ControlButton>
            ) : null}

            {canPip ? (
              <ControlButton
                label="Picture in picture"
                onClick={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (document.pictureInPictureElement)
                    void document.exitPictureInPicture();
                  else
                    void video.requestPictureInPicture().catch(() => undefined);
                }}
              >
                <PictureInPicture2 className="size-5" />
              </ControlButton>
            ) : null}

            <ControlButton
              label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              onClick={() => toggleFullscreen(containerRef.current)}
            >
              {fullscreen ? (
                <Minimize className="size-5" />
              ) : (
                <Maximize className="size-5" />
              )}
            </ControlButton>

            <MoreMenu
              canControl={canControl}
              onCopyLink={copyLink}
              onRestart={() => send({ kind: "restart" })}
            />
          </div>
        </div>

        {/* Mobile: four primary actions plus one sheet for everything else.
            Nothing here depends on hover, because nothing on a phone can. */}
        <div className="flex items-center justify-between gap-1 sm:hidden">
          <div className="flex items-center gap-0.5">
            <ControlButton
              label={paused ? "Play" : "Pause"}
              disabled={!canControl}
              onClick={toggle}
              className="size-11"
            >
              {paused ? (
                <Play className="size-6 fill-current" />
              ) : (
                <Pause className="size-6 fill-current" />
              )}
            </ControlButton>
            <ControlButton
              label={`Back ${SKIP} seconds`}
              disabled={!canControl || live}
              onClick={() => seekBy(-SKIP)}
              className="size-10"
            >
              <RotateCcw className="size-5" />
            </ControlButton>
            <ControlButton
              label={`Forward ${SKIP} seconds`}
              disabled={!canControl || live}
              onClick={() => seekBy(SKIP)}
              className="size-10"
            >
              <RotateCw className="size-5" />
            </ControlButton>
          </div>

          <div className="flex items-center gap-0.5">
            <VolumeControl
              muted={muted}
              volume={volume}
              slider={hasVolume}
              open={volumeOpen}
              onOpenChange={setVolumeOpen}
              onMute={toggleMute}
              onVolume={applyVolume}
              compact
            />
            <ControlButton
              label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              onClick={() => toggleFullscreen(containerRef.current)}
              className="size-10"
            >
              {fullscreen ? (
                <Minimize className="size-5" />
              ) : (
                <Maximize className="size-5" />
              )}
            </ControlButton>
            <MobileMoreSheet
              canControl={canControl}
              live={live}
              looping={timeline?.loop ?? false}
              onToggleLoop={toggleLoop}
              rate={timeline?.rate ?? 1}
              onRate={(rate) => send({ kind: "set_rate", rate })}
              qualities={qualities}
              quality={quality}
              onQuality={applyQuality}
              theatre={theatre}
              onTheatre={onTheatre}
              canPip={canPip}
              onPip={() => {
                const video = videoRef.current;
                if (!video) return;
                if (document.pictureInPictureElement)
                  void document.exitPictureInPicture();
                else
                  void video.requestPictureInPicture().catch(() => undefined);
              }}
              onPrevious={() => send({ kind: "previous" })}
              onNext={() => send({ kind: "next" })}
              onRestart={() => send({ kind: "restart" })}
              onCopyLink={copyLink}
            />
          </div>
        </div>
      </div>
    </div>
  );

  if (!theatre) return player;

  // Theatre owns its own centring instead of trusting whatever the room wraps
  // it in. `dvh` rather than `vh` so mobile browser chrome collapsing does not
  // leave a sliver of dead space at the bottom, and the flex centring means
  // the 16:9 box is never pinned to a corner with leftover black margin — it
  // sits in the middle of whatever room the viewport actually has.
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-black">
      {player}
    </div>
  );
}

type SyncAction =
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "seek"; position: number }
  | { kind: "set_rate"; rate: number }
  | { kind: "set_loop"; loop: boolean }
  | { kind: "play_now"; queueItemId: string }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "restart" };

/**
 * The auto-hiding chrome.
 *
 * Held open whenever the room is not actually playing. Desktop wakes on
 * pointer movement and sleeps on a timer; touch has no hover, so a tap either
 * wakes a sleeping bar (and stops there — the tap is spent) or, if the bar is
 * already awake, falls through to the play/pause button underneath it.
 */
function useChrome(pinned: boolean): {
  visible: boolean;
  wake: (active?: boolean) => void;
  tap: () => void;
} {
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

  const tap = useCallback(() => wake(true), [wake]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return { visible: pinned || awake, wake, tap };
}

/**
 * The seek bar: a thin rule that thickens under the pointer, with a larger
 * invisible hit area than its visible track so a thumb can land on it without
 * needing surgeon's aim.
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
      <SliderPrimitive.Control className="relative flex h-5 w-full touch-none items-center select-none data-disabled:opacity-60 sm:h-3">
        <SliderPrimitive.Track className="relative h-[4px] w-full grow overflow-hidden rounded-full bg-white/40 transition-[height] sm:h-[3px] sm:group-hover/seek:h-[5px]">
          <div
            className="h-full rounded-full bg-white"
            style={{ width: `${Math.round(progress * 1000) / 10}%` }}
          />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="relative block size-3.5 shrink-0 rounded-full bg-white opacity-100 shadow transition-opacity after:absolute after:-inset-3 focus-visible:outline-2 focus-visible:outline-white/70 sm:size-3 sm:opacity-0 sm:group-hover/seek:opacity-100" />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

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
            aria-label={
              looping ? "Stop repeating this video" : "Repeat this video"
            }
            onClick={() => onToggle(!looping)}
            className={cn(
              "size-9 text-white hover:bg-white/15 hover:text-white",
              looping && "bg-white/20 text-white hover:bg-white/25",
            )}
          >
            {looping ? (
              <Repeat1 className="size-5" />
            ) : (
              <Repeat className="size-5" />
            )}
          </Button>
        }
      />
      <TooltipContent>
        {looping ? "Repeating this video" : "Repeat this video when it ends"}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Volume is purely local — it is the one control that must never be shared, or
 * one person's headphones set the level for everybody in the room.
 *
 * Desktop expands the slider on hover, the way it always has. Touch has no
 * hover, so tapping the icon toggles the same expanded state explicitly —
 * both paths land on one `open` flag rather than forking into two controls.
 */
function VolumeControl({
  muted,
  volume,
  slider,
  open,
  onOpenChange,
  onMute,
  onVolume,
  compact = false,
}: {
  muted: boolean;
  volume: number;
  /** False for a source that can only be muted or not — Kick has no level. */
  slider: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMute: () => void;
  onVolume: (value: number) => void;
  /** Mobile: the button opens a small floating popover instead of expanding inline. */
  compact?: boolean;
}) {
  const Icon =
    muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  if (!slider) {
    return (
      <ControlButton
        label={muted ? "Unmute" : "Mute"}
        onClick={onMute}
        className={compact ? "size-10" : undefined}
      >
        <Icon className={compact ? "size-5" : "size-5"} />
      </ControlButton>
    );
  }

  if (compact) {
    return (
      <div className="relative">
        <ControlButton
          label={muted ? "Unmute" : "Mute"}
          onClick={() => onOpenChange(!open)}
          className="size-10"
        >
          <Icon className="size-5" />
        </ControlButton>
        {open ? (
          <div className="-translate-x-1/2 absolute bottom-full left-1/2 mb-2 flex h-24 items-center rounded-lg bg-black/90 px-2 py-3 backdrop-blur-sm">
            <SliderPrimitive.Root
              value={[muted ? 0 : volume]}
              min={0}
              max={1}
              step={0.05}
              orientation="vertical"
              thumbAlignment="edge"
              aria-label="Volume"
              onValueChange={(next) => {
                const value = firstThumb(next);
                if (value != null) onVolume(value);
              }}
              className="h-full"
            >
              <SliderPrimitive.Control className="relative flex h-full w-8 touch-none flex-col items-center justify-end select-none">
                <SliderPrimitive.Track className="relative w-[4px] grow overflow-hidden rounded-full bg-white/40">
                  <SliderPrimitive.Indicator className="w-full rounded-full bg-white" />
                </SliderPrimitive.Track>
                <SliderPrimitive.Thumb className="relative block size-3.5 shrink-0 rounded-full bg-white after:absolute after:-inset-3" />
              </SliderPrimitive.Control>
            </SliderPrimitive.Root>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="group/volume flex items-center"
      onMouseEnter={() => onOpenChange(true)}
      onMouseLeave={() => onOpenChange(false)}
    >
      <ControlButton label={muted ? "Unmute" : "Mute"} onClick={onMute}>
        <Icon className="size-5" />
      </ControlButton>
      <div
        className={cn("w-0 overflow-hidden transition-[width]", open && "w-20")}
      >
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

function QualityMenu({
  qualities,
  quality,
  onSelect,
}: {
  qualities: string[];
  quality: string | null;
  onSelect: (next: string | null) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Quality"
            className="h-9 min-w-9 gap-1.5 px-2 text-xs font-medium text-white hover:bg-white/15 hover:text-white"
          >
            <Settings2 className="size-4" />
            {quality ? <span data-numeric>{quality}</span> : null}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Quality</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onSelect(null)}>
            Auto{quality === null ? " ·" : ""}
          </DropdownMenuItem>
          {qualities.map((option) => (
            <DropdownMenuItem key={option} onClick={() => onSelect(option)}>
              {option}
              {option === quality ? " ·" : ""}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RateMenu({
  rate,
  onSelect,
}: {
  rate: number;
  onSelect: (rate: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Playback speed"
            className="h-9 min-w-9 px-2 text-xs font-medium text-white hover:bg-white/15 hover:text-white"
          >
            {rate}×
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Playback speed</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {RATES.map((option) => (
            <DropdownMenuItem key={option} onClick={() => onSelect(option)}>
              {option}×{option === rate ? " ·" : ""}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MoreMenu({
  canControl,
  onCopyLink,
  onRestart,
}: {
  canControl: boolean;
  onCopyLink: () => void;
  onRestart: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More"
            className="size-9 text-white hover:bg-white/15 hover:text-white"
          >
            <MoreHorizontal className="size-5" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onCopyLink}>
          <Copy className="size-4" />
          Copy source URL
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canControl} onClick={onRestart}>
          <RotateCcw className="size-4" />
          Restart from the beginning
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Everything that doesn't fit — or doesn't make sense — on a phone's primary
 * row. One menu instead of six icons: loop, speed, quality, theatre, PiP,
 * previous/next, restart, copy link. Grouped so the two most likely actions
 * (previous/next) sit at the top rather than buried under settings.
 */
function MobileMoreSheet({
  canControl,
  live,
  looping,
  onToggleLoop,
  rate,
  onRate,
  qualities,
  quality,
  onQuality,
  theatre,
  onTheatre,
  canPip,
  onPip,
  onPrevious,
  onNext,
  onRestart,
  onCopyLink,
}: {
  canControl: boolean;
  live: boolean;
  looping: boolean;
  onToggleLoop: (next: boolean) => void;
  rate: number;
  onRate: (rate: number) => void;
  qualities: string[];
  quality: string | null;
  onQuality: (next: string | null) => void;
  theatre: boolean;
  onTheatre?: () => void;
  canPip: boolean;
  onPip: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRestart: () => void;
  onCopyLink: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More controls"
            className="size-10 text-white hover:bg-white/15 hover:text-white"
          >
            <MoreHorizontal className="size-5" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={!canControl} onClick={onPrevious}>
            <SkipBack className="size-4" />
            Previous
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canControl} onClick={onNext}>
            <SkipForward className="size-4" />
            Next
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={!canControl}
            onClick={() => onToggleLoop(!looping)}
          >
            {looping ? (
              <Repeat1 className="size-4" />
            ) : (
              <Repeat className="size-4" />
            )}
            {looping ? "Repeating — tap to stop" : "Repeat this video"}
          </DropdownMenuItem>
          {!live ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Gauge className="size-4" />
                Speed · {rate}×
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {RATES.map((option) => (
                  <DropdownMenuItem key={option} onClick={() => onRate(option)}>
                    {option === rate ? (
                      <Check className="size-4" />
                    ) : (
                      <span className="size-4" />
                    )}
                    {option}×
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {qualities.length > 1 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Settings2 className="size-4" />
                Quality · {quality ?? "Auto"}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => onQuality(null)}>
                  {quality === null ? (
                    <Check className="size-4" />
                  ) : (
                    <span className="size-4" />
                  )}
                  Auto
                </DropdownMenuItem>
                {qualities.map((option) => (
                  <DropdownMenuItem
                    key={option}
                    onClick={() => onQuality(option)}
                  >
                    {option === quality ? (
                      <Check className="size-4" />
                    ) : (
                      <span className="size-4" />
                    )}
                    {option}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {onTheatre ? (
            <DropdownMenuItem onClick={onTheatre}>
              {theatre ? (
                <RectangleHorizontal className="size-4" />
              ) : (
                <Frame className="size-4" />
              )}
              {theatre ? "Exit theatre mode" : "Theatre mode"}
            </DropdownMenuItem>
          ) : null}
          {canPip ? (
            <DropdownMenuItem onClick={onPip}>
              <PictureInPicture2 className="size-4" />
              Picture in picture
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onCopyLink}>
            <Copy className="size-4" />
            Copy source URL
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canControl} onClick={onRestart}>
            <RotateCcw className="size-4" />
            Restart from the beginning
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusOverlay({
  awaiting,
  buffering,
  error,
  paused,
  canControl,
  poster,
  onSkip,
}: {
  awaiting: boolean;
  buffering: boolean;
  error: string | null;
  paused: boolean;
  canControl: boolean;
  poster: string | null;
  onSkip: () => void;
}) {
  if (error) {
    return (
      <div className="absolute inset-0 z-30 grid place-items-center p-6 text-center">
        <Artwork poster={poster} dim="bg-black/85" />
        <div className="relative max-w-sm space-y-2">
          <p className="text-sm font-medium text-white">
            Can't play this source
          </p>
          <p className="text-xs text-white/70">{error}</p>
          {canControl ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={onSkip}
              className="mt-2"
            >
              Skip to next
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (awaiting || buffering) {
    return (
      <div className="pointer-events-none absolute inset-0 z-20">
        <Artwork poster={poster} dim="bg-black/40" />
        <div className="absolute inset-x-0 top-0 h-[3px] overflow-hidden">
          <div className="h-full w-1/3 animate-indeterminate rounded-full bg-white/90" />
        </div>
        {awaiting ? (
          <p className="absolute inset-x-0 bottom-20 text-center text-xs text-white/80">
            Waiting for everyone to load…
          </p>
        ) : null}
      </div>
    );
  }

  if (!paused) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
      <Artwork poster={poster} dim="bg-black/45" />
      <span className="relative grid size-14 place-items-center rounded-full bg-black/55 backdrop-blur-sm sm:size-16">
        <Play className="size-6 fill-white text-white sm:size-7" />
      </span>
    </div>
  );
}

function UnmuteOverlay({ onUnmute }: { onUnmute: () => void }) {
  return (
    <div className="absolute inset-x-0 top-0 z-30 flex justify-center p-3 sm:p-4">
      <Button
        size="sm"
        onClick={onUnmute}
        className="gap-2 rounded-full bg-white text-black shadow-lg hover:bg-white/90"
      >
        <VolumeX className="size-4" />
        Tap for sound
      </Button>
    </div>
  );
}

function Artwork({ poster, dim }: { poster: string | null; dim: string }) {
  if (!poster) return <span className={cn("absolute inset-0", dim)} />;

  return (
    <>
      <span
        className="absolute inset-0 scale-110 bg-cover bg-center blur-xl"
        style={{ backgroundImage: `url(${poster})` }}
      />
      <span
        className="absolute inset-0 bg-contain bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${poster})` }}
      />
      <span className={cn("absolute inset-0", dim)} />
    </>
  );
}

function posterFor(
  source: MediaSource,
  queueThumbnail: string | undefined,
): string | null {
  if (queueThumbnail) return queueThumbnail;
  if (source.kind === "youtube" && source.videoId) {
    return `https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg`;
  }
  return null;
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
              "size-9 text-white hover:bg-white/15 hover:text-white disabled:opacity-40",
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

function firstThumb(value: number | readonly number[]): number | undefined {
  return typeof value === "number" ? value : value[0];
}

function titleFromSource(source: MediaSource): string {
  if (source.kind === "youtube") return "YouTube video";
  if (source.kind === "twitch" || source.kind === "kick") {
    const name = source.url.split("/").filter(Boolean).pop();
    return name ?? (source.kind === "twitch" ? "Twitch" : "Kick");
  }
  try {
    const { pathname, hostname } = new URL(source.url);
    const file = pathname.split("/").filter(Boolean).pop();
    return file ? decodeURIComponent(file) : hostname;
  } catch {
    return "Now playing";
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
  if (awaiting) return "Waiting for everyone to load…";
  if (buffering) return "Buffering…";
  if (nowPlaying?.channelTitle) return nowPlaying.channelTitle;
  if (source.kind === "kick") return "Kick";
  if (source.kind === "twitch") return "Twitch";
  if (live) return "Live stream";
  try {
    return new URL(source.url).hostname;
  } catch {
    return source.kind.toUpperCase();
  }
}

export type { MediaSource };
