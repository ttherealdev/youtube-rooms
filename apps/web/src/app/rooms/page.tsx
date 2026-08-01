'use client';

import { useQuery } from '@tanstack/react-query';
import { Lock, Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { SiteHeader } from '~/components/site-header';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty';
import { Input } from '~/components/ui/input';
import { Skeleton } from '~/components/ui/skeleton';
import { api } from '~/lib/api';
import { cn, debounce, formatRelative } from '~/lib/utils';

interface DirectoryItem {
  id: string;
  slug: string;
  name: string;
  topic: string | null;
  category: string;
  host: { displayName: string; initials: string; avatarHue: number };
  participantCount: number;
  maxParticipants: number;
  hasPassword: boolean;
  nowPlaying: { title: string; thumbnailUrl: string } | null;
  createdAt: number;
}

const SORTS = [
  ['trending', 'Trending'],
  ['active', 'Most active'],
  ['newest', 'Newest'],
] as const;

const CATEGORIES = ['anime', 'gaming', 'programming', 'music', 'movies', 'education'] as const;

export default function RoomDirectory() {
  const [sort, setSort] = useState<string>('trending');
  const [category, setCategory] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');

  // Debounced so typing does not fire a request per keystroke.
  const [commit] = useState(() => debounce((value: string) => setQuery(value.trim()), 300));

  const rooms = useQuery({
    queryKey: ['rooms', sort, category, query],
    queryFn: () => {
      const params = new URLSearchParams({ sort });
      if (category) params.set('category', category);
      if (query) params.set('q', query);
      return api<{ items: DirectoryItem[] }>(`/api/rooms?${params}`);
    },
  });

  return (
    <div className="min-h-dvh">
      <SiteHeader />

      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Public rooms</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop into anything that looks good. No invite needed.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              commit(event.target.value);
            }}
            placeholder="Search rooms"
            aria-label="Search public rooms"
            className="max-w-xs"
          />

          <div className="flex rounded-md border p-0.5">
            {SORTS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setSort(value)}
                aria-pressed={sort === value}
                className={cn(
                  'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
                  sort === value
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {CATEGORIES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setCategory(category === value ? null : value)}
              aria-pressed={category === value}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs capitalize transition-colors',
                category === value
                  ? 'border-transparent bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:border-foreground/25 hover:text-foreground',
              )}
            >
              {value}
            </button>
          ))}
        </div>

        <div className="mt-8">
          {rooms.isPending ? (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
                <li key={key}>
                  <Skeleton className="h-48 rounded-xl" />
                </li>
              ))}
            </ul>
          ) : rooms.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Couldn’t load rooms</EmptyTitle>
                <EmptyDescription>The server didn’t answer. It may be restarting.</EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" onClick={() => void rooms.refetch()}>
                Try again
              </Button>
            </Empty>
          ) : rooms.data.items.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {query ? 'Nothing matched that' : 'No public rooms right now'}
                </EmptyTitle>
                <EmptyDescription>
                  {query
                    ? 'Try a different search, or start your own room.'
                    : 'Be the first — make one and share the link.'}
                </EmptyDescription>
              </EmptyHeader>
              <Button render={<Link href="/rooms/new" />}>
                <Plus className="size-4" />
                Create a room
              </Button>
            </Empty>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rooms.data.items.map((room) => (
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
      href={`/rooms/${room.slug}`}
      className="group flex h-full flex-col overflow-hidden rounded-xl border transition-colors hover:border-foreground/25"
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {room.nowPlaying?.thumbnailUrl ? (
          // Thumbnails come from arbitrary hosts, including imported playlist
          // logos that frequently 404, so a plain <img> is the honest choice.
          <img
            src={room.nowPlaying.thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : null}

        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2">
          <Badge variant="secondary" className="gap-1">
            <Users className="size-3" />
            <span data-numeric>
              {room.participantCount}/{room.maxParticipants}
            </span>
          </Badge>
          {room.hasPassword ? (
            <Lock className="size-3.5 text-white/80" aria-label="Password protected" />
          ) : null}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <h2 className="line-clamp-1 text-sm font-medium">{room.name}</h2>
        {room.nowPlaying ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">
            <span className="text-primary">Now playing</span> · {room.nowPlaying.title}
          </p>
        ) : room.topic ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{room.topic}</p>
        ) : null}

        <div className="mt-auto flex items-center justify-between pt-1.5 text-xs text-muted-foreground">
          <span className="truncate">{room.host.displayName}</span>
          <span>{full ? 'Full' : formatRelative(room.createdAt)}</span>
        </div>
      </div>
    </Link>
  );
}
