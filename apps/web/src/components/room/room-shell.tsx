import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Link2, MessageSquare, Settings, Users, Video } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { JoinGate } from '~/components/join-gate';
import { ChatPanel } from '~/components/room/chat';
import { ParticipantsPanel } from '~/components/room/participants';
import { Player } from '~/components/room/player';
import { QueuePanel } from '~/components/room/queue';
import { SettingsPanel } from '~/components/room/settings';
import { useTheme } from '~/components/theme-provider';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { type RoomShortcutActions, useRoomShortcuts } from '~/hooks/use-room-shortcuts';
import { useSession } from '~/hooks/use-session';
import { api } from '~/lib/api';
import { asThemeKey, asThemeMode } from '~/lib/themes';
import { cn } from '~/lib/utils';
import type { PlayerEngine } from '~/realtime/player/engine';
import { RoomSocket } from '~/realtime/socket';
import { useConnection, usePermissions, useRoomStore, useUnreadChat } from '~/stores/room-store';

/**
 * The room.
 *
 * Owns the socket for exactly as long as the room is mounted, and is the single
 * place where server messages become client state. Everything below it reads
 * from the store and sends intents back through the socket it is handed.
 */
export function RoomShell({ slug }: { slug: string }) {
  const { state: session } = useSession();
  const [socket, setSocket] = useState<RoomSocket | null>(null);
  const [engine, setEngine] = useState<PlayerEngine | null>(null);
  const [panel, setPanel] = useState<'chat' | 'queue' | 'people' | 'settings'>('chat');
  const [theatre, setTheatre] = useTheatreMode();
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const apply = useRoomStore((s) => s.apply);
  const setConnection = useRoomStore((s) => s.setConnection);
  const reset = useRoomStore((s) => s.reset);
  const connection = useConnection();
  const room = useRoomStore((s) => s.room);
  const kicked = useRoomStore((s) => s.kicked);
  const permissions = usePermissions();
  const unread = useUnreadChat();
  const markChatRead = useRoomStore((s) => s.markChatRead);

  // The room id is not in the URL — the slug is — so it has to be resolved
  // before a socket can be opened.
  const lookup = useQuery({
    queryKey: ['room', slug],
    queryFn: () => api<{ id: string; name: string }>(`/api/rooms/by-slug/${slug}`),
    retry: false,
  });

  // Connecting needs an identity: the socket authenticates with a ticket the
  // API will only mint for a signed-in user. Without this guard an anonymous
  // visitor opening a shared link watched the socket fail and retry forever
  // instead of being asked for a name.
  const roomId = session.status === 'authenticated' ? lookup.data?.id : undefined;

  useEffect(() => {
    if (!roomId) return;

    const next = new RoomSocket(roomId);
    const offMessage = next.onMessage(apply);
    const offState = next.onStateChange(setConnection);

    void next.connect();
    setSocket(next);

    return () => {
      offMessage();
      offState();
      next.close();
      setSocket(null);
      // Leaving must not strand the next room with this one's participants.
      reset();
    };
  }, [roomId, apply, setConnection, reset]);

  useRoomTheme(room?.settings.theme, room?.settings.themeMode);
  useErrorToasts();

  // Opening the chat is what marks it read; the count keeps rising while any
  // other panel is in front of it.
  useEffect(() => {
    if (panel === 'chat' && unread > 0) markChatRead();
  }, [panel, unread, markChatRead]);

  // Keyboard control. The hook was written for the previous shell and lost its
  // only caller in the framework move, which quietly removed every shortcut in
  // the room.
  useRoomShortcuts({
    socket,
    engine,
    actions: useShortcutActions({ setPanel, chatInputRef, playerRef, setTheatre }),
  });

  if (lookup.isPending) {
    return <Centered>{<Spinner />}</Centered>;
  }

  if (lookup.isError) {
    return (
      <Centered>
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-medium">Room not found</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            This room may have closed. Rooms are removed shortly after everyone leaves.
          </p>
          <Button render={<Link to="/rooms" />} variant="outline" size="sm">
            Browse rooms
          </Button>
        </div>
      </Centered>
    );
  }

  // Joining is deliberately the one place a guest name is asked for: it is the
  // only flow where continuing without an account actually works.
  if (session.status === 'loading') {
    return <Centered>{<Spinner />}</Centered>;
  }

  if (session.status === 'anonymous') {
    return (
      <JoinGate
        onJoined={() => undefined}
        title={lookup.data ? `Join ${lookup.data.name}` : 'Choose a name'}
        description="This is how everyone in the room will see you. You can change it later."
      />
    );
  }

  if (kicked) {
    return (
      <Centered>
        <div className="space-y-2 text-center">
          <h1 className="text-lg font-medium">
            {kicked === 'room_closed' ? 'This room has closed' : 'You were removed'}
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            {kicked === 'room_closed'
              ? 'Everyone left, so the room was closed.'
              : 'A host removed you from this room.'}
          </p>
          <Button render={<Link to="/rooms" />} variant="outline" size="sm">
            Browse rooms
          </Button>
        </div>
      </Centered>
    );
  }

  return (
    // `overflow-hidden` is load-bearing: the room owns exactly one viewport and
    // scrolls only inside its panels. Without it any child that overshoots by a
    // pixel — a 16:9 box rounded up, a border on a full-height column — puts a
    // scrollbar on the *page*, which is what made theatre mode grow a bar down
    // the right and along the bottom.
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Theatre mode reclaims the header's height for the picture. The room
          name is still reachable — it is in the player's own title line — so
          nothing is lost but chrome. */}
      <header className={cn('flex items-center gap-3 border-b px-4 py-2.5', theatre && 'hidden')}>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{room?.name ?? 'Loading…'}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {connection === 'open' ? (
              room?.topic || `${slug}`
            ) : (
              <span className="text-amber-500">
                {connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
              </span>
            )}
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(window.location.href);
            toast.success('Invite link copied');
          }}
        >
          <Link2 className="size-4" />
          <span className="hidden sm:inline">Copy link</span>
        </Button>
      </header>

      {/* Theatre keeps the two columns — the whole point is watching *with*
          people — but gives the player every pixel the chat does not need, and
          lets it fill the height instead of sitting in a padded card.

          Both layouts are single-column below `lg`. Theatre used to pin a
          320px sidebar at every width, so on a narrow screen the two columns
          could not both fit and the row overflowed sideways. `minmax(0,…)` on
          the picture column is the other half of that: a bare `1fr` refuses to
          shrink below its contents, and a 16:9 box is very wide content. */}
      <div
        className={cn(
          'grid min-h-0 flex-1',
          theatre ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : 'lg:grid-cols-[minmax(0,1fr)_380px]',
        )}
      >
        <main
          ref={playerRef}
          className={cn(
            'min-h-0 min-w-0',
            theatre
              ? 'overflow-hidden bg-black lg:grid lg:place-items-center'
              : 'overflow-y-auto p-4',
          )}
        >
          <Player
            socket={socket}
            onEngine={setEngine}
            theatre={theatre}
            onTheatre={() => setTheatre((on) => !on)}
          />
        </main>

        <aside className="flex min-h-0 min-w-0 flex-col border-t lg:border-t-0 lg:border-l">
          <Tabs
            value={panel}
            onValueChange={(next) => setPanel((next as typeof panel) ?? 'chat')}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="m-2 shrink-0">
              <TabsTrigger value="chat" className="relative">
                <MessageSquare className="size-4" />
                <span className="hidden sm:inline">Chat</span>
                {unread > 0 && panel !== 'chat' ? (
                  <span
                    role="status"
                    className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums"
                  >
                    {unread > 99 ? '99+' : unread}
                    <span className="sr-only"> unread messages</span>
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="queue">
                <Video className="size-4" />
                <span className="hidden sm:inline">Queue</span>
              </TabsTrigger>
              <TabsTrigger value="people">
                <Users className="size-4" />
                <span className="hidden sm:inline">People</span>
              </TabsTrigger>
              {permissions?.canEditRoom ? (
                <TabsTrigger value="settings">
                  <Settings className="size-4" />
                  <span className="hidden sm:inline">Settings</span>
                </TabsTrigger>
              ) : null}
            </TabsList>

            <TabsContent value="chat" className="min-h-0 flex-1">
              <ChatPanel socket={socket} inputRef={chatInputRef} />
            </TabsContent>
            <TabsContent value="queue" className="min-h-0 flex-1">
              <QueuePanel socket={socket} />
            </TabsContent>
            <TabsContent value="people" className="min-h-0 flex-1">
              <ParticipantsPanel socket={socket} />
            </TabsContent>
            <TabsContent value="settings" className="min-h-0 flex-1">
              <SettingsPanel />
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  );
}

/**
 * Bind the shortcut hook's abstract actions to this shell's concrete parts.
 *
 * Memoised because the hook re-registers its key listener whenever the actions
 * change identity, and an object literal would be a new one every render.
 */
function useShortcutActions({
  setPanel,
  chatInputRef,
  playerRef,
  setTheatre,
}: {
  setPanel: (panel: 'chat' | 'queue' | 'people' | 'settings') => void;
  chatInputRef: React.RefObject<HTMLTextAreaElement | null>;
  playerRef: React.RefObject<HTMLDivElement | null>;
  setTheatre: React.Dispatch<React.SetStateAction<boolean>>;
}): RoomShortcutActions {
  const focusChat = useCallback(() => {
    setPanel('chat');
    // After the panel switch has painted, or the field does not exist yet.
    requestAnimationFrame(() => chatInputRef.current?.focus());
  }, [setPanel, chatInputRef]);

  return useMemo<RoomShortcutActions>(
    () => ({
      focusChat,
      focusSearch: () => setPanel('queue'),
      showPanel: (next) => setPanel(next),
      toggleHelp: () =>
        toast.info(
          'Shortcuts: space play/pause · ←/→ seek · f fullscreen · t theatre · c chat · q queue',
        ),
      requestFullscreen: () => {
        const node = playerRef.current?.querySelector('[class*="aspect-video"]');
        if (node instanceof HTMLElement) void node.requestFullscreen().catch(() => undefined);
      },
      toggleTheatre: () => setTheatre((on) => !on),
    }),
    [focusChat, setPanel, playerRef, setTheatre],
  );
}

/**
 * Show the server's refusals.
 *
 * Every rejected intent already arrived and was stored, and nothing ever
 * rendered it — so "you cannot control playback here", "that room is full" and
 * "you're doing that too quickly" all presented identically, as a button that
 * did nothing. Reads the error and clears it, so the same message can be shown
 * again the next time it happens.
 */
function useErrorToasts(): void {
  const lastError = useRoomStore((s) => s.lastError);

  useEffect(() => {
    if (!lastError) return;
    toast.error(lastError);
    useRoomStore.setState({ lastError: null });
  }, [lastError]);
}

/**
 * Theatre mode, remembered across rooms and reloads.
 *
 * A layout preference, not room state: it is about this person's screen, so it
 * never touches the socket. Read in an effect rather than during render — the
 * server has no `localStorage`, and reading it inline would break hydration.
 */
function useTheatreMode(): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [theatre, setTheatre] = useState(false);

  useEffect(() => {
    try {
      setTheatre(localStorage.getItem(THEATRE_KEY) === '1');
    } catch {
      /* Private mode blocks storage; the default is already correct. */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(THEATRE_KEY, theatre ? '1' : '0');
    } catch {
      /* Nothing to do — the preference simply will not persist. */
    }
  }, [theatre]);

  return [theatre, setTheatre];
}

const THEATRE_KEY = 'playercn:theatre';

/**
 * Apply the room's theme while inside it, and hand control back on the way out.
 *
 * The cleanup is the important half: without it, leaving a room would strand
 * the visitor in the host's palette for the rest of the session.
 */
function useRoomTheme(theme: string | undefined, mode: string | undefined): void {
  const { setRoomTheme } = useTheme();

  useEffect(() => {
    if (!theme) return;
    setRoomTheme(asThemeKey(theme), asThemeMode(mode));
    return () => setRoomTheme(null, null);
  }, [theme, mode, setRoomTheme]);
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-dvh place-items-center p-6">{children}</div>;
}

export { Badge };
