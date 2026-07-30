import { useState } from 'react';
import { InviteIllustration, Logo } from '~/components/illustrations';
import { Button } from '~/components/ui/button';
import { Field, Input } from '~/components/ui/field';
import { useSession } from '~/hooks/use-session';
import { ApiError } from '~/lib/api';
import { initialsOf } from '~/lib/initials';

/**
 * The door.
 *
 * Guest entry is the primary path and is presented first — most people
 * arriving here followed a link from a group chat and have no intention of
 * creating an account (ADR 0007). Google is offered second, not as the default.
 */
export function JoinGate({ roomName, onJoined }: { roomName?: string; onJoined: () => void }) {
  const { signInAsGuest, signInWithGoogle } = useSession();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const preview = initialsOf(name);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);

    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (trimmed.length < 2) {
      setError('Please use at least 2 characters.');
      return;
    }

    setBusy(true);
    try {
      await signInAsGuest(trimmed);
      onJoined();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.fields?.displayName ?? cause.message)
          : 'Could not join. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <Logo />
          <InviteIllustration className="size-32 text-[var(--text-primary)]" />
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">
              {roomName ? `Join “${roomName}”` : 'Join the room'}
            </h1>
            <p className="text-sm text-[var(--text-muted)]">Pick a name. That is all we need.</p>
          </div>
        </div>

        <form onSubmit={submit} className="panel space-y-4 p-6" noValidate>
          <Field label="Display name" htmlFor="display-name" error={error}>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Anas Mohamed"
              maxLength={32}
              autoComplete="nickname"
              invalid={Boolean(error)}
            />
          </Field>

          <div className="flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--surface-hover)] p-3">
            <span
              className="grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
              style={{
                backgroundImage:
                  'linear-gradient(135deg, oklch(0.62 0.17 295), oklch(0.52 0.19 343))',
              }}
              aria-hidden
            >
              {preview}
            </span>
            <p className="text-xs text-[var(--text-muted)]">
              Your avatar is generated from your initials — no upload needed.
            </p>
          </div>

          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Join room
          </Button>

          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-[var(--border-subtle)]" />
            <span className="text-2xs uppercase tracking-wider text-[var(--text-muted)]">or</span>
            <span className="h-px flex-1 bg-[var(--border-subtle)]" />
          </div>

          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={() => signInWithGoogle(window.location.pathname)}
          >
            <GoogleMark />
            Continue with Google
          </Button>

          <p className="text-center text-2xs leading-relaxed text-[var(--text-muted)]">
            Signing in with Google lets you create rooms and keep your history. We only ask for your
            name, email and picture.
          </p>
        </form>
      </div>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.5 5.5 0 0 1-2.4 3.62v3h3.87c2.26-2.09 3.56-5.17 3.56-8.86"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.87-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.28v3.09A12 12 0 0 0 12 24"
      />
      <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.28a12 12 0 0 0 0 10.76z" />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.62l3.99 3.09C6.22 6.86 8.87 4.75 12 4.75"
      />
    </svg>
  );
}
