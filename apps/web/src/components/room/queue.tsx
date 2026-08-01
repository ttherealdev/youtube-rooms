import { mayBeLive, type QueueItem } from '@playercn/protocol';
import { ListPlus, Play, Plus, Radio, Shuffle, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { ScrollArea } from '~/components/ui/scroll-area';
import { formatDuration } from '~/lib/utils';
import type { RoomSocket } from '~/realtime/socket';
import { usePermissions, useQueue, useTimeline } from '~/stores/room-store';

/**
 * The shared queue.
 *
 * "Add" takes any URL. The server classifies it, so this input does not need to
 * know the difference between a YouTube link, an MP4 and an IPTV manifest —
 * which is precisely the VLC affordance: one box, paste anything.
 */
export function QueuePanel({ socket }: { socket: RoomSocket | null }) {
  const queue = useQueue();
  const timeline = useTimeline();
  const permissions = usePermissions();
  const canManage = permissions?.canManageQueue ?? false;
  const canControl = permissions?.canControlPlayback ?? false;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <AddSourceDialog socket={socket} disabled={!canManage} />
        <ImportPlaylistDialog socket={socket} disabled={!canManage} />
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Shuffle queue"
          title="Shuffle"
          disabled={!canManage || queue.length < 2}
          onClick={() => socket?.send({ t: 'queue_shuffle' })}
        >
          <Shuffle className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear queue"
          title="Clear"
          disabled={!canManage || queue.length === 0}
          onClick={() => socket?.send({ t: 'queue_clear' })}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {queue.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyTitle>Queue is empty</EmptyTitle>
              <EmptyDescription>
                {canManage
                  ? 'Add a link, or import a whole playlist.'
                  : 'The host has not queued anything yet.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y">
            {queue.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                canManage={canManage}
                canPlay={canControl}
                playing={timeline?.queueItemId === item.id}
                onPlay={() =>
                  timeline &&
                  socket?.send({
                    t: 'sync_intent',
                    action: { kind: 'play_now', queueItemId: item.id },
                    version: timeline.version,
                  })
                }
                onRemove={() => socket?.send({ t: 'queue_remove', itemId: item.id })}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function QueueRow({
  item,
  canManage,
  canPlay,
  playing,
  onPlay,
  onRemove,
}: {
  item: QueueItem;
  canManage: boolean;
  /** Distinct from `canManage`: editing the queue and driving playback are
      separate permissions, and this button does the latter. */
  canPlay: boolean;
  playing: boolean;
  onPlay: () => void;
  onRemove: () => void;
}) {
  const live = mayBeLive(item.source);

  return (
    <li className="group flex items-center gap-3 p-2.5 hover:bg-accent/50">
      <div className="relative size-10 shrink-0 overflow-hidden rounded bg-muted">
        {item.thumbnailUrl ? (
          // Playlist logos come from arbitrary hosts and frequently 404, so a
          // plain <img> that can fail quietly beats next/image here.
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        ) : (
          <span className="grid size-full place-items-center text-muted-foreground">
            <Radio className="size-4" />
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm leading-tight">{item.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {playing ? <span className="text-primary">Playing · </span> : null}
          {live ? 'Live' : formatDuration(item.durationSeconds || null)}
          {item.channelTitle ? ` · ${item.channelTitle}` : ''}
        </p>
      </div>

      {canManage || canPlay ? (
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {canPlay ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Play now"
              title="Play now"
              onClick={onPlay}
            >
              <Play className="size-3.5" />
            </Button>
          ) : null}
          {canManage ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove"
              title="Remove"
              onClick={onRemove}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * What the room accepts, stated where it is being asked for.
 *
 * "Paste a link" is only useful advice if you already know which links work.
 * Listing them at the point of entry is cheaper than a failed import and an
 * error message afterwards.
 */
function SupportedList({ groups }: { groups: readonly (readonly [string, string])[] }) {
  return (
    <dl className="mt-3 space-y-1.5 rounded-lg border bg-muted/40 p-3">
      {groups.map(([term, detail]) => (
        <div key={term} className="grid grid-cols-[6.5rem_1fr] gap-2 text-xs">
          <dt className="font-medium">{term}</dt>
          <dd className="text-muted-foreground">{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

function AddSourceDialog({ socket, disabled }: { socket: RoomSocket | null; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    socket?.send({ t: 'queue_add', url: trimmed, playNext: false });
    setUrl('');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" disabled={disabled}>
            <Plus className="size-4" />
            Add
          </Button>
        }
      />
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Open media</DialogTitle>
            <DialogDescription>
              Paste a link and the room works out how to play it.
            </DialogDescription>
          </DialogHeader>

          <SupportedList
            groups={[
              [
                'Video sites',
                'YouTube (video, short or live) · Twitch channel or VOD · Kick channel',
              ],
              ['Direct files', 'MP4 · WebM · MKV · MOV · MP3 · M4A — any URL a browser can decode'],
              ['Live streams', 'HLS (.m3u8) and DASH (.mpd) manifests'],
              ['Cloud links', 'Google Drive and Dropbox share links are converted automatically'],
            ]}
          />

          <div className="space-y-2 py-4">
            <Label htmlFor="source-url">Address</Label>
            <Input
              id="source-url"
              autoFocus
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://… or a YouTube link"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              The scheme is optional — <code className="font-mono">example.com/clip.mp4</code>{' '}
              works. Some servers refuse playback from another site; those cannot be played here.
            </p>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={!url.trim()}>
              Add to queue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportPlaylistDialog({
  socket,
  disabled,
}: {
  socket: RoomSocket | null;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    socket?.send({ t: 'queue_import', url: trimmed });
    toast('Importing playlist…', {
      description: 'Large lists take a moment and are capped at 500 entries.',
    });
    setUrl('');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline" disabled={disabled}>
            <ListPlus className="size-4" />
            Import
          </Button>
        }
      />
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Import a playlist</DialogTitle>
            <DialogDescription>
              Every entry on the list is added to the queue at once.
            </DialogDescription>
          </DialogHeader>

          <SupportedList
            groups={[
              ['Playlists', 'M3U and M3U8 (IPTV channel lists) · PLS'],
              ['Exports', 'XSPF from VLC or Clementine · ASX from Windows Media Player'],
              ['Limits', 'Up to 500 entries per import; anything longer is truncated'],
            ]}
          />

          <div className="space-y-2 py-4">
            <Label htmlFor="playlist-url">Playlist URL</Label>
            <Input
              id="playlist-url"
              autoFocus
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/channels.m3u"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Fetched by the server, so private and local addresses are refused.
            </p>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={!url.trim()}>
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
