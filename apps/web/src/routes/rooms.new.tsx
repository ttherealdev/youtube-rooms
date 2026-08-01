import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { SiteHeader } from '~/components/site-header';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { useSession } from '~/hooks/use-session';
import { ApiError, api } from '~/lib/api';
import { cn } from '~/lib/utils';

export const Route = createFileRoute('/rooms/new')({
  component: NewRoomPage,
});

const CATEGORIES = [
  'general',
  'anime',
  'gaming',
  'programming',
  'music',
  'movies',
  'education',
] as const;

const VISIBILITIES = [
  ['private', 'Private', 'Link only'],
  ['unlisted', 'Unlisted', 'Not listed'],
  ['public', 'Public', 'Listed for anyone'],
] as const;

function NewRoomPage() {
  const { state, signInWithGoogle } = useSession();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<string>('private');
  const [category, setCategory] = useState<string>('general');
  const [maxParticipants, setMaxParticipants] = useState(25);
  const [password, setPassword] = useState('');
  const [allowGuestQueue, setAllowGuestQueue] = useState(true);
  const [allowGuestControl, setAllowGuestControl] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (state.status === 'loading') {
    return (
      <main className="grid min-h-dvh place-items-center">
        <Spinner />
      </main>
    );
  }

  // Creating a room needs a real account, so this screen asks for one directly.
  // Offering "continue as guest" here — as the shared join gate does — walks
  // people into a dead end: they name themselves, sign in, and are then told
  // guests cannot own a room.
  if (state.status === 'anonymous' || state.user.kind === 'guest') {
    return (
      <SignInToCreate
        onContinue={() => signInWithGoogle('/rooms/new')}
        guest={state.status === 'authenticated'}
      />
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
          maxParticipants,
          allowGuestQueue,
          allowGuestControl,
          ...(password.trim() ? { password: password.trim() } : {}),
        },
      });
      void navigate({ to: '/rooms/$slug', params: { slug: room.slug } });
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
    <div className="min-h-dvh">
      <SiteHeader />

      <main className="mx-auto w-full max-w-lg px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Create a room</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You can change any of this later from room settings.
        </p>

        <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="room-name">Room name</Label>
            <Input
              id="room-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Friday film night"
              maxLength={60}
              aria-invalid={Boolean(errors.name)}
            />
            {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Who can find it</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {VISIBILITIES.map(([value, label, hint]) => (
                <label
                  key={value}
                  className={cn(
                    'cursor-pointer rounded-md border p-2.5 transition-colors',
                    visibility === value
                      ? 'border-primary bg-primary/5'
                      : 'hover:border-foreground/25',
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
                  <span className="block text-[11px] text-muted-foreground">{hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="room-category">Category</Label>
              <Select value={category} onValueChange={(value) => setCategory(value ?? category)}>
                <SelectTrigger id="room-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value} className="capitalize">
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="room-max">Maximum members</Label>
              <Input
                id="room-max"
                type="number"
                min={2}
                max={100}
                value={maxParticipants}
                onChange={(event) => setMaxParticipants(Number(event.target.value))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="room-password">Password</Label>
            <Input
              id="room-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Leave blank for no password"
              autoComplete="new-password"
              aria-invalid={Boolean(errors.password)}
            />
            <p className="text-xs text-muted-foreground">
              {errors.password ?? 'Optional. Anyone with the link will also need this.'}
            </p>
          </div>

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-medium">What members can do</legend>
            {(
              [
                [
                  'allow-guest-queue',
                  allowGuestQueue,
                  setAllowGuestQueue,
                  'Add to the queue',
                  'Recommended — it is what makes a room feel shared.',
                ],
                [
                  'allow-guest-control',
                  allowGuestControl,
                  setAllowGuestControl,
                  'Control playback',
                  'Anyone can play, pause and seek for everyone.',
                ],
              ] as const
            ).map(([id, checked, setter, label, hint]) => (
              <div key={id} className="flex items-start justify-between gap-4">
                <Label htmlFor={id} className="min-w-0 cursor-pointer font-normal">
                  <span className="block text-sm">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </Label>
                <Switch
                  id={id}
                  checked={checked}
                  onCheckedChange={setter}
                  className="mt-0.5 shrink-0"
                />
              </div>
            ))}
          </fieldset>

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Spinner className="size-4" /> : null}
            Create room
          </Button>
        </form>
      </main>
    </div>
  );
}

/**
 * A guest can join anything but cannot own a room: an anonymous owner cannot be
 * contacted or held responsible for a public one (ADR 0007).
 */
function SignInToCreate({ onContinue, guest }: { onContinue: () => void; guest: boolean }) {
  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="grid place-items-center px-6 py-24">
        <div className="max-w-sm space-y-4 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Sign in to create a room</h1>
          <p className="text-sm text-muted-foreground">
            {guest
              ? 'You are signed in as a guest, which is enough to join any room. Creating one needs a Google account so the room has an owner who can moderate it.'
              : 'Joining a room only needs a name, but creating one needs a Google account so the room has an owner who can moderate it.'}
          </p>
          <Button onClick={onContinue}>Continue with Google</Button>
        </div>
      </main>
    </div>
  );
}
