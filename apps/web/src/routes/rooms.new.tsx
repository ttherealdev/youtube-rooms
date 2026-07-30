import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { LoadingIllustration, Logo } from '~/components/illustrations';
import { JoinGate } from '~/components/join-gate';
import { Button } from '~/components/ui/button';
import { Field, Input } from '~/components/ui/field';
import { useSession } from '~/hooks/use-session';
import { ApiError, api } from '~/lib/api';
import { cn } from '~/lib/utils';

export const Route = createFileRoute('/rooms/new')({
  component: NewRoomPage,
});

const CATEGORIES = [
  ['general', 'General'],
  ['anime', 'Anime'],
  ['gaming', 'Gaming'],
  ['programming', 'Programming'],
  ['music', 'Music'],
  ['movies', 'Movies'],
  ['education', 'Education'],
] as const;

function NewRoomPage() {
  const { state, signInWithGoogle } = useSession();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public' | 'unlisted'>('private');
  const [category, setCategory] = useState<string>('general');
  const [password, setPassword] = useState('');
  const [allowGuestQueue, setAllowGuestQueue] = useState(true);
  const [allowGuestControl, setAllowGuestControl] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (state.status === 'loading') {
    return (
      <main className="grid min-h-dvh place-items-center">
        <LoadingIllustration />
      </main>
    );
  }

  // Guests can join anything but cannot own a room — an anonymous owner cannot
  // be contacted or held responsible for a public room (ADR 0007).
  if (state.status === 'anonymous') {
    return <JoinGate onJoined={() => undefined} />;
  }

  if (state.user.kind === 'guest') {
    return (
      <main className="grid min-h-dvh place-items-center px-6">
        <div className="max-w-sm space-y-5 text-center">
          <Logo />
          <h1 className="text-xl font-semibold tracking-tight">Sign in to create a room</h1>
          <p className="text-sm text-[var(--text-muted)]">
            You are signed in as a guest, which is enough to join any room. Creating one needs a
            Google account so it has an owner who can moderate it.
          </p>
          <Button variant="primary" onClick={() => signInWithGoogle('/rooms/new')}>
            Continue with Google
          </Button>
          <p>
            <Link
              to="/rooms"
              className="text-xs text-[var(--text-muted)] underline-offset-4 hover:underline"
            >
              Browse rooms instead
            </Link>
          </p>
        </div>
      </main>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (name.trim().length < 2) {
      setErrors({ name: 'Give the room a name of at least 2 characters.' });
      return;
    }

    setBusy(true);
    try {
      const room = await api<{ slug: string }>('/api/rooms', {
        method: 'POST',
        body: {
          name: name.trim(),
          visibility,
          category,
          allowGuestQueue,
          allowGuestControl,
          ...(password.trim() ? { password: password.trim() } : {}),
        },
      });
      await navigate({ to: '/rooms/$slug', params: { slug: room.slug } });
    } catch (cause) {
      setErrors(
        cause instanceof ApiError
          ? (cause.fields ?? { name: cause.message })
          : { name: 'Could not create the room. Please try again.' },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-lg px-6 py-12">
      <Button asChild variant="ghost" size="sm" className="mb-6">
        <Link to="/rooms">
          <ArrowLeft aria-hidden />
          Back
        </Link>
      </Button>

      <h1 className="text-2xl font-semibold tracking-tight">Create a room</h1>
      <p className="mt-1.5 text-sm text-[var(--text-muted)]">
        You can change any of this later from room settings.
      </p>

      <form onSubmit={submit} className="panel mt-8 space-y-5 p-6" noValidate>
        <Field label="Room name" htmlFor="room-name" error={errors.name}>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Friday film night"
            maxLength={60}
            invalid={Boolean(errors.name)}
          />
        </Field>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-[var(--text-secondary)]">
            Who can find it
          </legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ['private', 'Private', 'Link only'],
                ['unlisted', 'Unlisted', 'Not in the directory'],
                ['public', 'Public', 'Listed for anyone'],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={cn(
                  'cursor-pointer rounded-[var(--radius-md)] border p-3 transition-colors',
                  visibility === value
                    ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]'
                    : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]',
                )}
              >
                <input
                  type="radio"
                  name="visibility"
                  value={value}
                  checked={visibility === value}
                  onChange={() => setVisibility(value)}
                  className="sr-only"
                />
                <span className="block text-xs font-medium">{label}</span>
                <span className="block text-2xs text-[var(--text-muted)]">{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Category" htmlFor="room-category">
          <select
            id="room-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="h-10 w-full rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-base)] px-3 text-sm"
          >
            {CATEGORIES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Password"
          htmlFor="room-password"
          hint="Optional. Anyone with the link will also need this."
          error={errors.password}
        >
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Leave blank for no password"
            autoComplete="new-password"
            invalid={Boolean(errors.password)}
          />
        </Field>

        <fieldset className="space-y-2.5">
          <legend className="mb-1 text-sm font-medium text-[var(--text-secondary)]">
            What guests can do
          </legend>
          {(
            [
              [
                allowGuestQueue,
                setAllowGuestQueue,
                'Add to the queue',
                'Recommended — it is what makes a room feel shared.',
              ],
              [
                allowGuestControl,
                setAllowGuestControl,
                'Control playback',
                'Anyone can play, pause and seek for everyone.',
              ],
            ] as const
          ).map(([checked, setter, label, hint]) => (
            <label key={label} className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => setter(event.target.checked)}
                className="mt-0.5 size-4 accent-[var(--accent)]"
              />
              <span>
                <span className="block text-sm">{label}</span>
                <span className="block text-2xs text-[var(--text-muted)]">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create room
        </Button>
      </form>
    </main>
  );
}
