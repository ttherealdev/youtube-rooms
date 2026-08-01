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
import type { PlayerEngine } from '~/realtime/player/engine';
import { RoomSocket } from '~/realtime/socket';
import { useConnection, usePermissions, useRoomStore } from '~/stores/room-store';

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
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const apply = useRoomStore((s) => s.apply);
  const setConnection = useRoomStore((s) => s.setConnection);
  const reset = useRoomStore((s) => s.reset);
  const connection = useConnection();
  const room = useRoomStore((s) => s.room);
  const kicked = useRoomStore((s) => s.kicked);
  const permissions = usePermissions();

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

  // Keyboard control. The hook was written for the previous shell and lost its
  // only caller in the framework move, which quietly removed every shortcut in
  // the room.
  useRoomShortcuts({
    socket,
    engine,
    actions: useShortcutActions({ setPanel, chatInputRef, playerRef }),
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
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
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

      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_380px]">
        <main ref={playerRef} className="min-h-0 overflow-y-auto p-4">
          <Player socket={socket} onEngine={setEngine} />
        </main>

        <aside className="flex min-h-0 flex-col border-t lg:border-t-0 lg:border-l">
          <Tabs
            value={panel}
            onValueChange={(next) => setPanel((next as typeof panel) ?? 'chat')}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="m-2 shrink-0">
              <TabsTrigger value="chat">
                <MessageSquare className="size-4" />
                <span className="hidden sm:inline">Chat</span>
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
              <ChatPanel socket={socket} />
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
}: {
  setPanel: (panel: 'chat' | 'queue' | 'people' | 'settings') => void;
  chatInputRef: React.RefObject<HTMLTextAreaElement | null>;
  playerRef: React.RefObject<HTMLDivElement | null>;
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
        toast.info('Shortcuts: space play/pause · ←/→ seek · f fullscreen · c chat'),
      requestFullscreen: () => {
        const node = playerRef.current?.querySelector('[class*="aspect-video"]');
        if (node instanceof HTMLElement) void node.requestFullscreen().catch(() => undefined);
      },
    }),
    [focusChat, setPanel, playerRef],
  );
}

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
