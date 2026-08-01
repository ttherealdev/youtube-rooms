import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Exponential backoff with full jitter, capped.
 *
 * The jitter is not decoration. When a server restarts, every client in every
 * room reconnects at once; without randomising the delay they all retry on the
 * same schedule and keep knocking the server over as it comes back up.
 */
export function backoffDelay(attempt: number, base = 500, max = 15_000): number {
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.random() * ceiling;
}

/** Trailing-edge debounce. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

/**
 * `mm:ss`, or `h:mm:ss` past an hour.
 *
 * Returns an em dash for a length we do not know — a live stream, or a file
 * nobody has played yet — because "0:00" reads as a real duration and is wrong.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';

  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);

  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "just now", "4 minutes ago", "3 days ago" — from an epoch-millisecond stamp. */
export function formatRelative(epochMs: number): string {
  const seconds = Math.round((Date.now() - epochMs) / 1000);
  if (seconds < 45) return 'just now';

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let value = seconds;
  for (const [unit, step] of units) {
    if (Math.abs(value) < step) {
      return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(
        -Math.round(value),
        unit,
      );
    }
    value /= step;
  }
  return 'a long time ago';
}
