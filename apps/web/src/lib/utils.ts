import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind-aware class merge: later utilities win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** `3:07`, or `1:02:44` once past an hour. Never shows a leading `0:` hour. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';

  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);

  const pad = (n: number) => n.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Relative time for chat and room cards. Deliberately coarse past a day. */
export function formatRelative(epochMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - epochMs);
  const minutes = Math.floor(delta / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(epochMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** `1.2K`, `3.4M` — compact counts for view numbers and participant tallies. */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Deterministic gradient for a generated avatar.
 *
 * Mirrors the server's hue derivation so a user looks identical whether their
 * summary came from the socket or was rendered optimistically.
 */
export function avatarGradient(hue: number): string {
  return `linear-gradient(135deg, oklch(0.62 0.17 ${hue}), oklch(0.52 0.19 ${(hue + 48) % 360}))`;
}

let idCounter = 0;
/** Client-side nonce for optimistic messages. */
export function nonce(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Trailing-edge debounce. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): ((...args: A) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const debounced = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
  };

  return debounced;
}

/** Exponential backoff with full jitter, capped. Used by the socket (ADR 0004). */
export function backoffDelay(attempt: number, baseMs = 500, capMs = 15_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  // Full jitter: without it, every client in a room reconnects in lockstep and
  // thunders the server the instant it comes back.
  return Math.random() * exponential;
}
