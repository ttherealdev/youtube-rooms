import { useMutation } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { ScrollArea } from '~/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Separator } from '~/components/ui/separator';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api';
import { THEMES, type ThemeKey, type ThemeMode } from '~/lib/themes';
import { cn } from '~/lib/utils';
import { usePermissions, useRoomStore } from '~/stores/room-store';

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
  ['private', 'Private — link only'],
  ['unlisted', 'Unlisted — not in the directory'],
  ['public', 'Public — listed for anyone'],
] as const;

/**
 * Room settings.
 *
 * Host-only, and enforced server-side — this panel is not rendered for anyone
 * else, but hiding it is a courtesy, not the authorisation.
 *
 * Changes go over REST rather than the socket because they are form
 * submissions with validation errors to report. The server broadcasts
 * `room_updated` afterwards, so everyone in the room — including this client —
 * learns the new state through the same path.
 */
export function SettingsPanel() {
  const room = useRoomStore((s) => s.room);
  const permissions = usePermissions();
  const canEdit = permissions?.canEditRoom ?? false;

  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [visibility, setVisibility] = useState<string>('private');
  const [category, setCategory] = useState<string>('general');
  const [maxParticipants, setMaxParticipants] = useState(25);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [allowGuestQueue, setAllowGuestQueue] = useState(true);
  const [allowGuestControl, setAllowGuestControl] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [voteSkipRatio, setVoteSkipRatio] = useState(0.5);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Re-seed whenever the room changes underneath us — including from our own
  // save, which returns through the socket like everyone else's.
  useEffect(() => {
    if (!room) return;
    setName(room.name);
    setTopic(room.topic ?? '');
    setVisibility(room.visibility);
    setCategory(room.category);
    setMaxParticipants(room.maxParticipants);
    setAllowGuestQueue(room.settings.allowGuestQueue);
    setAllowGuestControl(room.settings.allowGuestControl);
    setAutoAdvance(room.settings.autoAdvance);
    setVoteSkipRatio(room.settings.voteSkipRatio);
  }, [room]);

  const save = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      if (!room) throw new Error('no room');
      return api(`/api/rooms/${room.id}`, { method: 'PATCH', body: patch });
    },
    onSuccess: () => {
      setErrors({});
      setPassword('');
      setClearPassword(false);
      toast.success('Room updated');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.fields) {
        setErrors(error.fields);
        return;
      }
      toast.error(error instanceof ApiError ? error.message : 'Could not save those settings.');
    },
  });

  if (!room) return null;

  if (!canEdit) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <p className="max-w-xs text-sm text-muted-foreground">
          Only the host can change this room’s settings.
        </p>
      </div>
    );
  }

  const submitDetails = (event: React.FormEvent) => {
    event.preventDefault();
    save.mutate({
      name: name.trim(),
      topic: topic.trim() || null,
      visibility,
      category,
      maxParticipants,
      // Absent means "leave it alone"; explicit null removes it. Sending an
      // empty string instead would set the password to nothing.
      ...(clearPassword
        ? { password: null }
        : password.trim()
          ? { password: password.trim() }
          : {}),
    });
  };

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-4">
        <form onSubmit={submitDetails} className="space-y-4">
          <Field label="Room name" htmlFor="room-name" error={errors.name}>
            <Input
              id="room-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
            />
          </Field>

          <Field label="Topic" htmlFor="room-topic" hint="Optional. Shown in the directory.">
            <Input
              id="room-topic"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              maxLength={200}
              placeholder="What’s on tonight?"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Visibility" htmlFor="room-visibility" error={errors.visibility}>
              <Select
                value={visibility}
                onValueChange={(value) => setVisibility(value ?? visibility)}
              >
                <SelectTrigger id="room-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VISIBILITIES.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Category" htmlFor="room-category">
              <Select value={category} onValueChange={(value) => setCategory(value ?? category)}>
                <SelectTrigger id="room-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value[0]?.toUpperCase()}
                      {value.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field
            label="Maximum members"
            htmlFor="room-max"
            hint="Between 2 and 100. Counts people present, not everyone who has ever joined."
            error={errors.maxParticipants}
          >
            <Input
              id="room-max"
              type="number"
              min={2}
              max={100}
              value={maxParticipants}
              onChange={(event) => setMaxParticipants(Number(event.target.value))}
            />
          </Field>

          <Field
            label="Password"
            htmlFor="room-password"
            hint="Leave blank to keep the current one."
            error={errors.password}
          >
            <Input
              id="room-password"
              type="password"
              value={password}
              autoComplete="new-password"
              disabled={clearPassword}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••"
            />
            <Label
              htmlFor="room-clear-password"
              className="mt-2 flex cursor-pointer items-center gap-2 text-xs font-normal text-muted-foreground"
            >
              <Switch
                id="room-clear-password"
                checked={clearPassword}
                onCheckedChange={setClearPassword}
              />
              Remove the password entirely
            </Label>
          </Field>

          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save changes
          </Button>
        </form>

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-medium">Permissions</h3>
          <Toggle
            id="room-guest-queue"
            label="Members can add to the queue"
            hint="Recommended — it is what makes a room feel shared."
            checked={allowGuestQueue}
            onChange={(next) => {
              setAllowGuestQueue(next);
              save.mutate({ allowGuestQueue: next });
            }}
          />
          <Toggle
            id="room-guest-control"
            label="Members can control playback"
            hint="Anyone can play, pause and seek for everyone."
            checked={allowGuestControl}
            onChange={(next) => {
              setAllowGuestControl(next);
              save.mutate({ allowGuestControl: next });
            }}
          />
          <Toggle
            id="room-auto-advance"
            label="Play the next item automatically"
            hint="When off, the room stops on the final frame."
            checked={autoAdvance}
            onChange={(next) => {
              setAutoAdvance(next);
              save.mutate({ autoAdvance: next });
            }}
          />

          <Field
            label="Vote-skip threshold"
            htmlFor="room-skip"
            hint={`${Math.round(voteSkipRatio * 100)}% of people present must agree.`}
          >
            <input
              id="room-skip"
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={voteSkipRatio}
              onChange={(event) => setVoteSkipRatio(Number(event.target.value))}
              onPointerUp={() => save.mutate({ voteSkipRatio })}
              onKeyUp={() => save.mutate({ voteSkipRatio })}
              className="w-full accent-primary"
            />
          </Field>
        </section>

        <Separator />

        <RoomTheme
          theme={room.settings.theme}
          mode={room.settings.themeMode}
          onChange={(patch) => save.mutate(patch)}
        />
      </div>
    </ScrollArea>
  );
}

/**
 * The room's own appearance.
 *
 * Applies to everyone in the room, not just the host setting it — which is why
 * it is a room setting rather than a personal one, and why it is gated behind
 * `canSetRoomTheme` on the server.
 */
function RoomTheme({
  theme,
  mode,
  onChange,
}: {
  theme: string;
  mode: string;
  onChange: (patch: { theme?: ThemeKey; themeMode?: ThemeMode }) => void;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Room theme</h3>
        <p className="text-xs text-muted-foreground">
          Applied to everyone in this room while they are here.
        </p>
      </div>

      <div className="flex gap-2">
        {(['light', 'dark'] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={mode === value ? 'default' : 'outline'}
            onClick={() => onChange({ themeMode: value })}
          >
            {value === 'light' ? 'Light' : 'Dark'}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {THEMES.map((entry) => {
          const [background, surface, primary] = mode === 'dark' ? entry.dark : entry.light;
          const selected = theme === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => onChange({ theme: entry.key })}
              aria-pressed={selected}
              className={cn(
                'flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-all',
                selected
                  ? 'border-primary ring-2 ring-primary/25'
                  : 'border-border hover:border-foreground/25',
              )}
            >
              <span
                className="flex h-8 w-full items-end gap-1 overflow-hidden rounded border border-black/5 p-1"
                style={{ background }}
                aria-hidden
              >
                <span className="h-full flex-1 rounded-[2px]" style={{ background: surface }} />
                <span className="h-full w-1/3 rounded-[2px]" style={{ background: primary }} />
              </span>
              <span className="flex items-center justify-between text-xs">
                <span className="truncate">{entry.label}</span>
                {selected ? <Check className="size-3 shrink-0 text-primary" /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  // `exactOptionalPropertyTypes` is on, so these have to admit `undefined`
  // explicitly — callers pass `errors.name`, which is exactly that.
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  // Base UI's Switch is a <button role="switch">, not an <input>, so a
  // wrapping label has nothing to bind to. An explicit id/htmlFor pair is both
  // what screen readers need and what makes the text clickable.
  return (
    <div className="flex items-start justify-between gap-4">
      <Label htmlFor={id} className="min-w-0 cursor-pointer font-normal">
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </div>
  );
}
