import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Lock, Plus, Search, Users } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { EmptyQueueIllustration, Logo } from '~/components/illustrations';
import { Avatar } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { Badge, EmptyState, Input, LiveDot, Skeleton } from '~/components/ui/field';
import { api } from '~/lib/api';
import { cn, debounce, formatRelative } from '~/lib/utils';

/**
 * The public directory.
 *
 * Filters live in the URL, not in component state: a filtered view is
 * shareable, survives a refresh, and gets back/forward for free.
 */
const searchSchema = z.object({
  sort: z.enum(['trending', 'newest', 'active']).default('trending'),
  category: z
    .enum(['general', 'anime', 'gaming', 'programming', 'music', 'movies', 'education'])
    .optional(),
  q: z.string().optional(),
});

export const Route = createFileRoute('/rooms/')({
  validateSearch: searchSchema,
  component: RoomDirectory,
});

interface DirectoryItem {
  id: string;
  slug: string;
  name: string;
  topic: string | null;
  category: string;
  host: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    initials: string;
    avatarHue: number;
    kind: string;
  };
  participantCount: number;
  maxParticipants: number;
  hasPassword: boolean;
  nowPlaying: { videoId: string; title: string; thumbnailUrl: string } | null;
  createdAt: number;
}

const SORTS = [
  ['trending', 'Trending'],
  ['active', 'Most active'],
  ['newest', 'Newest'],
] as const;

const CATEGORIES = [
  ['anime', 'Anime'],
  ['gaming', 'Gaming'],
  ['programming', 'Programming'],
  ['music', 'Music'],
  ['movies', 'Movies'],
  ['education', 'Education'],
] as const;

function RoomDirectory() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [draft, setDraft] = useState(search.q ?? '');

  // Debounced so typing does not fire a query per keystroke, and pushed into
  // the URL so the result is shareable.
  const commitSearch = debounce((value: string) => {
    void navigate({
      search: (prev) => ({ ...prev, q: value.trim() || undefined }),
      replace: true,
    });
  }, 300);

  const query = useQuery({
    queryKey: ['rooms', search],
    queryFn: () => {
      const params = new URLSearchParams({ sort: search.sort });
      if (search.category) params.set('category', search.category);
      if (search.q) params.set('q', search.q);
      return api<{ items: DirectoryItem[]; nextPage: number | null }>(
        `/api/rooms?${params.toString()}`,
      );
    },
  });

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-[var(--border-subtle)] glass">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link to="/" aria-label="YouTube Room home">
            <Logo showWordmark={false} />
          </Link>

          <div className="relative max-w-md flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]"
              aria-hidden
            />
            <Input
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                commitSearch(event.target.value);
              }}
              placeholder="Search rooms"
              aria-label="Search public rooms"
              className="pl-9"
            />
          </div>

          <Button asChild variant="primary" size="sm">
            <Link to="/rooms/new">
              <Plus aria-hidden />
              <span className="hidden sm:inline">New room</span>
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <h1 className="text-3xl font-semibold tracking-tight">Public rooms</h1>
        <p className="mt-1.5 text-sm text-[var(--text-muted)]">
          Drop into anything that looks good. No invite needed.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-2">
          <div className="flex rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-0.5">
            {SORTS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => void navigate({ search: (p) => ({ ...p, sort: value }) })}
                aria-pressed={search.sort === value}
                className={cn(
                  'rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-medium transition-colors',
                  search.sort === value
                    ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="mx-1 h-5 w-px bg-[var(--border-subtle)]" aria-hidden />

          {CATEGORIES.map(([value, label]) => {
            const active = search.category === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() =>
                  void navigate({
                    search: (p) => ({ ...p, category: active ? undefined : value }),
                  })
                }
                aria-pressed={active}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'border-transparent bg-[var(--accent)] text-[var(--accent-contrast)]'
                    : 'border-[var(--border-subtle)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="mt-8">
          {query.isPending ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
                <Skeleton key={key} className="h-56 rounded-[var(--radius-xl)]" />
              ))}
            </div>
          ) : query.isError ? (
            <EmptyState
              title="Couldn't load rooms"
              description="The server didn't answer. It may be restarting."
              action={
                <Button variant="secondary" onClick={() => void query.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : query.data.items.length === 0 ? (
            <EmptyState
              illustration={
                <EmptyQueueIllustration className="size-40 text-[var(--text-primary)]" />
              }
              title={search.q ? 'Nothing matched that' : 'No public rooms right now'}
              description={
                search.q
                  ? 'Try a different search, or start your own room.'
                  : 'Be the first — make one and share the link.'
              }
              action={
                <Button asChild variant="primary">
                  <Link to="/rooms/new">
                    <Plus aria-hidden />
                    Create a room
                  </Link>
                </Button>
              }
            />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {query.data.items.map((room) => (
                <li key={room.id}>
                  <RoomCard room={room} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

function RoomCard({ room }: { room: DirectoryItem }) {
  const full = room.participantCount >= room.maxParticipants;

  return (
    <Link
      to="/rooms/$slug"
      params={{ slug: room.slug }}
      className={cn(
        'group flex h-full flex-col overflow-hidden rounded-[var(--radius-xl)]',
        'border border-[var(--border-subtle)] bg-[var(--surface-raised)]',
        'transition-[border-color,transform,box-shadow] duration-200',
        'hover:-translate-y-0.5 hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-lift)]',
      )}
    >
      <div className="relative aspect-video overflow-hidden bg-[var(--surface-base)]">
        {room.nowPlaying ? (
          <img
            src={room.nowPlaying.thumbnailUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="size-full"
            style={{
              background: 'radial-gradient(ellipse at 40% 30%, var(--ambient-a), transparent 70%)',
            }}
            aria-hidden
          />
        )}

        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent p-3">
          <Badge tone={room.participantCount > 0 ? 'live' : 'neutral'}>
            {room.participantCount > 0 ? <LiveDot /> : null}
            <Users className="size-3" aria-hidden />
            <span data-numeric>
              {room.participantCount}/{room.maxParticipants}
            </span>
          </Badge>
          {room.hasPassword ? (
            <Lock className="size-3.5 text-white/80" aria-label="Password protected" />
          ) : null}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <h2 className="line-clamp-1 font-medium tracking-tight">{room.name}</h2>

        {room.nowPlaying ? (
          <p className="line-clamp-1 text-xs text-[var(--text-muted)]">
            <span className="text-[var(--accent)]">Now playing</span> · {room.nowPlaying.title}
          </p>
        ) : room.topic ? (
          <p className="line-clamp-2 text-xs text-[var(--text-muted)]">{room.topic}</p>
        ) : null}

        <div className="mt-auto flex items-center justify-between pt-2">
          <span className="flex items-center gap-2">
            <Avatar user={room.host} size="xs" />
            <span className="truncate text-2xs text-[var(--text-muted)]">
              {room.host.displayName}
            </span>
          </span>
          <span className="text-2xs text-[var(--text-muted)]">
            {full ? 'Full' : formatRelative(room.createdAt)}
          </span>
        </div>
      </div>
    </Link>
  );
}
