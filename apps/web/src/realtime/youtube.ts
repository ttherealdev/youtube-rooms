/**
 * A thin, typed wrapper over the YouTube IFrame API.
 *
 * The API is a global-callback, script-injection design from another era, so
 * everything awkward about it is contained here: one shared loader promise, no
 * duplicate script tags, and a normal Promise-based surface for the rest of the
 * app.
 */

export const PlayerState = {
  Unstarted: -1,
  Ended: 0,
  Playing: 1,
  Paused: 2,
  Buffering: 3,
  Cued: 5,
} as const;

export type PlayerStateValue = (typeof PlayerState)[keyof typeof PlayerState];

export interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
  cueVideoById(videoId: string, startSeconds?: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): PlayerStateValue;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  setVolume(volume: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  destroy(): void;
}

interface YouTubeApi {
  Player: new (
    element: HTMLElement | string,
    config: {
      videoId?: string;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YouTubePlayer }) => void;
        onStateChange?: (event: { data: PlayerStateValue; target: YouTubePlayer }) => void;
        onError?: (event: { data: number }) => void;
      };
    },
  ) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loader: Promise<YouTubeApi> | undefined;

/** Load the IFrame API once per document, however many players mount. */
export function loadYouTubeApi(): Promise<YouTubeApi> {
  if (loader) return loader;

  loader = new Promise<YouTubeApi>((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('YouTube API is browser-only'));
      return;
    }

    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    // The API calls a *global* when ready. Chain rather than overwrite, in case
    // something else on the page is also waiting.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
      else reject(new Error('YouTube API loaded without YT global'));
    };

    const existing = document.querySelector<HTMLScriptElement>('script[data-youtube-api]');
    if (existing) return;

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.dataset.youtubeApi = 'true';
    script.onerror = () => reject(new Error('failed to load the YouTube IFrame API'));
    document.head.appendChild(script);
  });

  return loader;
}

/**
 * Privacy-enhanced host.
 *
 * Same player, no cookies until something actually plays. Passed explicitly
 * because the API defaults to the tracking host.
 */
export const PLAYER_HOST = 'https://www.youtube-nocookie.com';

/**
 * Player parameters. Chosen to keep YouTube's own chrome out of the way.
 *
 * What these can and cannot do is worth being honest about. They remove the
 * control bar, the keyboard handlers, annotations and info cards. They do
 * **not** remove the related-video grid YouTube draws over a *paused* or
 * *ended* video — `rel=0` has meant "related videos from this channel only"
 * rather than "no related videos" since 2018, and there is no parameter that
 * turns it off. The room covers the iframe instead; see the player's paused
 * backdrop.
 *
 * The "Includes paid promotion" badge is also not removable, and should not
 * be: it is a sponsorship disclosure the uploader is obliged to show.
 */
export const PLAYER_VARS = {
  autoplay: 0,
  controls: 0,
  disablekb: 1,
  modestbranding: 1,
  rel: 0,
  playsinline: 1,
  iv_load_policy: 3,
  fs: 0,
  // Required by the API when the page is not served from the embedding origin.
  origin: typeof window !== 'undefined' ? window.location.origin : '',
} as const;

/** Errors the API reports, translated into something a person can act on. */
export function describePlayerError(code: number): string {
  switch (code) {
    case 2:
      return 'That video ID is not valid.';
    case 5:
      return 'This video cannot play in the embedded player.';
    case 100:
      return 'That video was removed or made private.';
    case 101:
    case 150:
      return "The uploader doesn't allow this video to be played outside YouTube.";
    default:
      return 'The player hit an unexpected problem.';
  }
}
