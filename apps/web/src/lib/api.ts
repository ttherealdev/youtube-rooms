import { apiError } from '@playercn/protocol';

/**
 * The HTTP client.
 *
 * Two rules encoded here:
 *
 * 1. **The access token lives in memory only.** It is held in a module-scoped
 *    variable, never `localStorage`, so an XSS cannot read it (ADR 0007).
 * 2. **A 401 triggers exactly one refresh.** Concurrent requests that all 401
 *    share a single in-flight refresh rather than starting a stampede.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/**
 * Absolute URL for an API path.
 *
 * `api()` applies the same prefix internally. This is exported for the one flow
 * that cannot go through `fetch`: the OAuth handoff is a full-page navigation,
 * and a relative URL there resolves against the *web* origin, which serves no
 * `/api` routes in production.
 */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when retrying the identical request could plausibly succeed. */
  get isTransient(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the refresh-and-retry dance — used by the refresh call itself. */
  skipAuthRetry?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, skipAuthRetry, headers, ...rest } = options;

  const response = await fetch(`${BASE}${path}`, {
    ...rest,
    // Always send the refresh cookie; it is scoped to /api/auth so this is
    // cheap everywhere else.
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 && !skipAuthRetry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return api<T>(path, { ...options, skipAuthRetry: true });
    }
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'unknown';
  let message = response.statusText || 'Request failed';
  let fields: Record<string, string> | undefined;
  let retryAfterMs: number | undefined;

  try {
    const parsed = apiError.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
      fields = parsed.data.error.fields;
    }
  } catch {
    // A non-JSON error body (a proxy 502 page, say) is not worth surfacing
    // verbatim; the status line is more useful than the HTML.
  }

  const header = response.headers.get('retry-after');
  if (header) retryAfterMs = Number(header) * 1000;

  return new ApiError(response.status, code, message, fields, retryAfterMs);
}

/**
 * Exchange the refresh cookie for a new access token.
 *
 * Deduplicated: ten simultaneous 401s produce one refresh, not ten — and ten
 * would be worse than useless, because rotation means nine of them would look
 * like token reuse and revoke the session (ADR 0007).
 */
export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const result = await api<{ accessToken: string; expiresIn: number }>('/api/auth/refresh', {
        method: 'POST',
        skipAuthRetry: true,
      });
      setAccessToken(result.accessToken);
      scheduleRefresh(result.expiresIn);
      return result.accessToken;
    } catch {
      setAccessToken(null);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Refresh proactively at 80% of the token's life rather than reactively on a
 * 401 — a socket ticket request that fails mid-session is a visible stall.
 */
export function scheduleRefresh(expiresInSeconds: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const delay = Math.max(30_000, expiresInSeconds * 1000 * 0.8);
  refreshTimer = setTimeout(() => void refreshAccessToken(), delay);
}

export function cancelScheduledRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
}
