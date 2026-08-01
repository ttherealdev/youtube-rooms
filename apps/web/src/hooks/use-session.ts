import type { UserSummary } from '@playercn/protocol';
import { useCallback, useEffect, useState } from 'react';
import { api, apiUrl, refreshAccessToken, scheduleRefresh, setAccessToken } from '~/lib/api';

/**
 * Who is signed in, if anyone.
 *
 * On mount this attempts a silent refresh: the refresh cookie is httpOnly, so
 * the only way to discover an existing session is to ask the server. That one
 * request is why the app briefly reports `loading` rather than `anonymous`.
 */

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: UserSummary };

interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: UserSummary;
}

export function useSession() {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const token = await refreshAccessToken();
      if (cancelled) return;

      if (!token) {
        setState({ status: 'anonymous' });
        return;
      }

      try {
        const user = await api<UserSummary>('/api/auth/session');
        if (!cancelled) setState({ status: 'authenticated', user });
      } catch {
        if (!cancelled) setState({ status: 'anonymous' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signInAsGuest = useCallback(async (displayName: string) => {
    const session = await api<SessionResponse>('/api/auth/guest', {
      method: 'POST',
      body: { displayName },
    });
    setAccessToken(session.accessToken);
    scheduleRefresh(session.expiresIn);
    setState({ status: 'authenticated', user: session.user });
    return session.user;
  }, []);

  const signInWithGoogle = useCallback((returnTo: string) => {
    // A full navigation, not fetch: the OAuth flow needs the browser to follow
    // redirects and set cookies on the way back. It must be an absolute API URL
    // — the web and API run on separate hosts in production, and a relative one
    // lands on the web server, which has no /api routes.
    window.location.href = apiUrl(
      `/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`,
    );
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      setAccessToken(null);
      setState({ status: 'anonymous' });
    }
  }, []);

  const rename = useCallback(async (displayName: string) => {
    const user = await api<UserSummary>('/api/auth/session', {
      method: 'PATCH',
      body: { displayName },
    });
    setState({ status: 'authenticated', user });
    return user;
  }, []);

  return { state, signInAsGuest, signInWithGoogle, signOut, rename };
}
