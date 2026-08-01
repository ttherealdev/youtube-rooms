import type { UserSummary } from '@playercn/protocol';
import { createContext, useContext } from 'react';

/**
 * Who is signed in, if anyone.
 *
 * The state lives in a single provider (`SessionProvider`) rather than in each
 * caller. When this was a self-contained hook, every component that called it
 * ran its own silent refresh and kept its own copy of the user — so renaming
 * yourself in the header left the join gate, the room and the participant list
 * all showing the old name until a reload.
 */

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: UserSummary };

export interface SessionContextValue {
  state: SessionState;
  signInAsGuest: (displayName: string) => Promise<UserSummary>;
  signInWithGoogle: (returnTo: string) => void;
  signOut: () => Promise<void>;
  rename: (displayName: string) => Promise<UserSummary>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside <SessionProvider>.');
  }
  return value;
}
