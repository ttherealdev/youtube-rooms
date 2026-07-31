import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, Link2, ListMusic, MessageSquare, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { LoadingIllustration, WaitingRoomIllustration } from '~/components/illustrations';
import { JoinGate } from '~/components/join-gate';
import { ChatPanel, ReactionLayer } from '~/components/room/chat';
import { ParticipantsPanel, QueuePanel } from '~/components/room/panels';
import { PlayerSurface } from '~/components/room/player';
import { ShortcutsOverlay } from '~/components/room/shortcuts-overlay';
import { Button } from '~/components/ui/button';
import { Badge, EmptyState } from '~/components/ui/field';
import { type RoomShortcutActions, useRoomShortcuts } from '~/hooks/use-room-shortcuts';
import { useSession } from '~/hooks/use-session';
import { api } from '~/lib/api';
import { cn } from '~/lib/utils';
import { RoomSocket } from '~/realtime/socket';
import { usePlayerSync } from '~/realtime/use-player-sync';
import { useConnection, useRoomStore, useTimeline } from '~/stores/room-store';

export const Route = createFileRoute('/rooms/$slug')({
  component: RoomPage,
});

interface RoomLookup {
  id: string;
  slug: string;
  name: string;
  topic: string | null;
  hasPassword: boolean;
}

function RoomPage() {
  const { slug } = Route.useParams();
  const { state: session } = useSession();
  const [room, setRoom] = useState<RoomLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Resolve the slug before authenticating, so the join screen can name the
  // room the person was actually invited to.
  useEffect(() => {
    let cancelled = false;
    api<RoomLookup>(`/api/rooms/by-slug/${slug}`)
      .then((result) => !cancelled && setRoom(result))
      .catch(() => !cancelled && setLookupError('That room does not exist, or it was closed.'));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (lookupError) {
    return (
      <main className="grid min-h-dvh place-items-center px-6">
        <EmptyState
          illustration={<WaitingRoomIllustration className="size-44 text-[var(--text-primary)]" />}
          title="Room not found"
          description={lookupError}
          action={
            <Button asChild variant="primary">
              <Link to="/rooms">Browse rooms</Link>
            </Button>
          }
        />
      </main>
    );
  }

  if (session.status === 'loading' || !room) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <LoadingIllustration />
      </main>
    );
  }

  if (session.status === 'anonymous') {
    // `key` forces a remount once the session resolves, so the gate cannot
    // linger with stale state after a successful join.
    return <JoinGate roomName={room.name} onJoined={() => undefined} key="gate" />;
  }

  return <ConnectedRoom room={room} />;
}

function ConnectedRoom({ room }: { room: RoomLookup }) {
  const socketRef = useRef<RoomSocket | null>(null);
  const [socket, setSocket] = useState<RoomSocket | null>(null);

  const apply = useRoomStore((state) => state.apply);
  const setConnection = useRoomStore((state) => state.setConnection);
  const reset = useRoomStore((state) => state.reset);
  const kicked = useRoomStore((state) => state.kicked);
  const connection = useConnection();
  const timeline = useTimeline();

  const player = usePlayerSync(socket, timeline);

  const [tab, setTab] = useState<PanelId>('chat');
  const [helpOpen, setHelpOpen] = useState(false);
  const [mini, setMini] = useState(false);

  /**
   * Focus is resolved by attribute rather than by threading refs down through
   * the panel tree. The inputs live three components away and the shortcut is
   * the only caller.
   */
  const focusBy = useCallback((selector: string) => {
    // After `setTab`, so the field is visible by the time focus lands.
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(selector)?.focus();
    });
  }, []);

  const shortcutActions = useMemo<RoomShortcutActions>(
    () => ({
      showPanel: setTab,
      focusChat: () => focusBy('[data-room-chat-input]'),
      focusSearch: () => focusBy('[data-room-queue-input]'),
      toggleHelp: () => setHelpOpen((open) => !open),
      toggleMiniPlayer: () => setMini((value) => !value),
    }),
    [focusBy],
  );

  // Disabled while the help dialog is open so its own Escape/Tab handling wins.
  useRoomShortcuts({ socket, player, actions: shortcutActions, enabled: !helpOpen });

  useEffect(() => {
    const instance = new RoomSocket(room.id);
    socketRef.current = instance;
    setSocket(instance);

    const offMessage = instance.onMessage(apply);
    const offState = instance.onStateChange(setConnection);

    void instance.connect();

    return () => {
      offMessage();
      offState();
      instance.close();
      reset();
      socketRef.current = null;
    };
  }, [room.id, apply, setConnection, reset]);

  if (kicked) {
    return (
      <main className="grid min-h-dvh place-items-center px-6">
        <EmptyState
          illustration={<WaitingRoomIllustration className="size-44 text-[var(--text-primary)]" />}
          title={kicked === 'room_closed' ? 'The host closed this room' : 'You were removed'}
          description={
            kicked === 'room_closed'
              ? 'Everyone has been sent home. You can start your own room any time.'
              : 'A moderator removed you from this room.'
          }
          action={
            <Button asChild variant="primary">
              <Link to="/rooms">Browse other rooms</Link>
            </Button>
          }
        />
      </main>
    );
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <RoomHeader room={room} connection={connection} />

      <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[1fr_340px]">
        <div className="relative flex min-h-0 flex-col gap-3">
          <PlayerSurface player={player} socket={socket} mini={mini} onMiniChange={setMini} />
          <ReactionLayer />
        </div>

        <SidePanel socket={socket} tab={tab} onTabChange={setTab} />
      </div>

      <ShortcutsOverlay open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

function RoomHeader({
  room,
  connection,
}: {
  room: RoomLookup;
  connection: ReturnType<typeof useConnection>;
}) {
  const status = {
    idle: { label: 'Connecting…', tone: 'neutral' as const },
    connecting: { label: 'Connecting…', tone: 'neutral' as const },
    authenticating: { label: 'Joining…', tone: 'neutral' as const },
    open: { label: 'Connected', tone: 'success' as const },
    reconnecting: { label: 'Reconnecting…', tone: 'warning' as const },
    closed: { label: 'Disconnected', tone: 'warning' as const },
  }[connection];

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5">
      <Button asChild variant="ghost" size="icon-sm" aria-label="Leave room">
        <Link to="/rooms">
          <ArrowLeft />
        </Link>
      </Button>

      <div className="min-w-0">
        <h1 className="truncate text-sm font-medium">{room.name}</h1>
        {room.topic ? (
          <p className="truncate text-2xs text-[var(--text-muted)]">{room.topic}</p>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Badge tone={status.tone}>{status.label}</Badge>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(window.location.href)
              .then(() => toast.success('Invite link copied'))
              .catch(() => toast.error('Could not copy the link'));
          }}
        >
          <Link2 aria-hidden />
          <span className="hidden sm:inline">Invite</span>
        </Button>
      </div>
    </header>
  );
}

const TABS = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'queue', label: 'Queue', icon: ListMusic },
  { id: 'people', label: 'People', icon: Users },
] as const;

/** Which side panel is showing. Owned by the room so shortcuts can switch it. */
type PanelId = (typeof TABS)[number]['id'];

/**
 * Tabbed on every size.
 *
 * A three-column desktop layout was the first draft and it was wrong: at
 * 1280px each column was too narrow to read, and the same component tree now
 * serves mobile without a second implementation.
 */
function SidePanel({
  socket,
  tab,
  onTabChange,
}: {
  socket: RoomSocket | null;
  tab: PanelId;
  onTabChange: (tab: PanelId) => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
      <div
        role="tablist"
        aria-label="Room panels"
        className="flex shrink-0 border-b border-[var(--border-subtle)]"
      >
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`panel-${item.id}`}
              id={`tab-${item.id}`}
              onClick={() => onTabChange(item.id)}
              className={cn(
                'relative flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors',
                active
                  ? 'text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
              )}
            >
              <item.icon className="size-3.5" aria-hidden />
              {item.label}
              {active ? (
                <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[var(--accent)]" />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* All three stay mounted: unmounting chat would discard scroll position
          and re-run the virtualiser every time someone checks the queue. */}
      <div className="min-h-0 flex-1">
        <div
          id="panel-chat"
          role="tabpanel"
          aria-labelledby="tab-chat"
          hidden={tab !== 'chat'}
          className="h-full"
        >
          <ChatPanel socket={socket} />
        </div>
        <div
          id="panel-queue"
          role="tabpanel"
          aria-labelledby="tab-queue"
          hidden={tab !== 'queue'}
          className="h-full"
        >
          <QueuePanel socket={socket} />
        </div>
        <div
          id="panel-people"
          role="tabpanel"
          aria-labelledby="tab-people"
          hidden={tab !== 'people'}
          className="h-full"
        >
          <ParticipantsPanel socket={socket} />
        </div>
      </div>
    </aside>
  );
}
