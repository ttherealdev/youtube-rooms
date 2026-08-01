import type {
  ChatMessage,
  Participant,
  Permissions,
  QueueItem,
  RoomSnapshot,
  ServerMessage,
  Timeline,
  UserSummary,
} from '@playercn/protocol';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

/**
 * Live room state, fed exclusively by the socket.
 *
 * There is exactly one place where server truth becomes client state — the
 * `apply` reducer below — which is also the only place that needs a test
 * (ADR 0008).
 *
 * Note what is *absent*: the playback head. That value changes 60 times a
 * second and is driven imperatively through refs by the player controller. Put
 * it here and every chat message re-renders with it.
 */

const MAX_MESSAGES = 300;

interface RoomState {
  connection: 'idle' | 'connecting' | 'authenticating' | 'open' | 'reconnecting' | 'closed';
  self: UserSummary | null;
  role: string;
  permissions: Permissions | null;
  room: RoomSnapshot | null;
  timeline: Timeline | null;
  participants: Participant[];
  queue: QueueItem[];
  queueVersion: number;
  messages: ChatMessage[];
  pinned: ChatMessage[];
  typing: Set<string>;
  skipVotes: { votes: number; needed: number; voters: string[] };
  reactions: { id: string; userId: string; emoji: string; at: number }[];
  kicked: 'room_closed' | 'banned' | null;
  lastError: string | null;
  /**
   * Messages that have arrived since the chat panel was last looked at.
   *
   * Kept here rather than in the chat panel because the panel is unmounted
   * while another tab is open — the count has to survive exactly the period it
   * is counting.
   */
  unreadChat: number;

  apply: (message: ServerMessage) => void;
  setConnection: (state: RoomState['connection']) => void;
  dismissReaction: (id: string) => void;
  markChatRead: () => void;
  reset: () => void;
}

const initial = {
  connection: 'idle' as const,
  self: null,
  role: 'guest',
  permissions: null,
  room: null,
  timeline: null,
  participants: [],
  queue: [],
  queueVersion: 0,
  messages: [],
  pinned: [],
  typing: new Set<string>(),
  skipVotes: { votes: 0, needed: 0, voters: [] },
  reactions: [],
  kicked: null,
  lastError: null,
  unreadChat: 0,
};

export const useRoomStore = create<RoomState>((set, get) => ({
  ...initial,

  setConnection: (connection) => set({ connection }),
  dismissReaction: (id) => set((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) })),
  markChatRead: () => set({ unreadChat: 0 }),
  reset: () => set({ ...initial, typing: new Set() }),

  apply: (message) => {
    switch (message.t) {
      case 'ready':
        set({
          self: message.self,
          role: message.role,
          permissions: message.permissions,
          room: message.room,
          timeline: message.timeline,
          participants: message.participants,
          queue: message.queue,
          messages: message.recentMessages,
          pinned: message.pinnedMessages,
          kicked: null,
          lastError: null,
        });
        break;

      case 'timeline': {
        // Monotonic version guard. A delayed packet arriving after a newer one
        // must not roll the room backwards (ADR 0005 §2).
        const current = get().timeline;
        if (current && message.timeline.version <= current.version) return;
        set({ timeline: message.timeline });
        break;
      }

      case 'participant_joined':
        set((s) =>
          s.participants.some((p) => p.user.id === message.participant.user.id)
            ? s
            : { participants: [...s.participants, message.participant] },
        );
        break;

      case 'participant_left':
        set((s) => ({
          participants: s.participants.filter((p) => p.user.id !== message.userId),
          typing: removeFrom(s.typing, message.userId),
        }));
        break;

      case 'participant_updated':
        set((s) => ({
          participants: s.participants.map((p) =>
            p.user.id === message.participant.user.id ? message.participant : p,
          ),
        }));
        break;

      case 'queue_updated':
        // Same monotonic guard as the timeline: reorders are frequent and
        // arrive out of order under load.
        if (message.version <= get().queueVersion) return;
        set({ queue: message.items, queueVersion: message.version });
        break;

      case 'chat_message':
        set((s) => ({
          messages: appendMessage(s.messages, message.message),
          // Your own message is not news, and neither is the echo of the
          // optimistic bubble you are already looking at.
          unreadChat: message.message.author.id === s.self?.id ? s.unreadChat : s.unreadChat + 1,
        }));
        break;

      case 'chat_typing':
        set((s) => ({
          typing: message.active
            ? new Set(s.typing).add(message.userId)
            : removeFrom(s.typing, message.userId),
        }));
        break;

      case 'chat_pinned':
        set((s) => ({
          pinned: message.pinned
            ? [message.message, ...s.pinned.filter((m) => m.id !== message.message.id)]
            : s.pinned.filter((m) => m.id !== message.message.id),
          messages: s.messages.map((m) =>
            m.id === message.message.id ? { ...m, pinned: message.pinned } : m,
          ),
        }));
        break;

      case 'reaction':
        set((s) => ({
          reactions: [
            ...s.reactions.slice(-24),
            { id: `${message.userId}-${message.at}`, ...message },
          ],
        }));
        break;

      case 'skip_vote_update':
        set({
          skipVotes: {
            votes: message.votes,
            needed: message.needed,
            voters: message.voters,
          },
        });
        break;

      case 'voice_state':
        set((s) => ({
          participants: s.participants.map((p) =>
            p.user.id === message.userId
              ? { ...p, muted: message.muted, inVoice: message.inVoice }
              : p,
          ),
        }));
        break;

      case 'voice_peer_left':
        set((s) => ({
          participants: s.participants.map((p) =>
            p.user.id === message.userId ? { ...p, inVoice: false } : p,
          ),
        }));
        break;

      case 'room_updated':
        set({ room: message.room });
        break;

      case 'permissions_updated':
        // Broadcast to the whole room so it survives a cross-node hop, so this
        // is where it becomes "mine". Without the guard, being in a room where
        // someone else is promoted would hand you their authority.
        if (message.userId !== get().self?.id) return;
        set({ role: message.role, permissions: message.permissions });
        break;

      case 'kicked':
        set({ kicked: message.reason === 'room_closed' ? 'room_closed' : 'banned' });
        break;

      case 'error':
        set({ lastError: message.message });
        break;

      // Handled elsewhere: clock samples in the socket, signalling in the voice
      // controller, read receipts in the chat panel.
      case 'pong':
      case 'chat_read':
      case 'voice_peer_joined':
      case 'voice_signal':
      case 'voice_capacity':
        break;
    }
  },
}));

function removeFrom(set_: Set<string>, id: string): Set<string> {
  const next = new Set(set_);
  next.delete(id);
  return next;
}

/**
 * Append, reconciling an optimistic bubble by nonce and capping history.
 *
 * Without the nonce match the sender sees their own message twice — once
 * optimistically and once echoed.
 */
function appendMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  if (incoming.nonce) {
    const index = messages.findIndex((m) => m.nonce === incoming.nonce);
    if (index !== -1) {
      const next = [...messages];
      next[index] = incoming;
      return next;
    }
  }

  // Idempotent against a duplicate delivered by two nodes during failover.
  if (messages.some((m) => m.id === incoming.id)) return messages;

  const next = [...messages, incoming];
  return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
}

// --- Selectors --------------------------------------------------------------
// Narrow subscriptions so a chat message does not re-render the queue.

export const useTimeline = () => useRoomStore((s) => s.timeline);
export const usePermissions = () => useRoomStore((s) => s.permissions);
export const useSelf = () => useRoomStore((s) => s.self);
export const useConnection = () => useRoomStore((s) => s.connection);
export const useQueue = () => useRoomStore(useShallow((s) => s.queue));
export const useParticipants = () => useRoomStore(useShallow((s) => s.participants));
export const useMessages = () => useRoomStore(useShallow((s) => s.messages));
export const useUnreadChat = () => useRoomStore((s) => s.unreadChat);
export const useSkipVotes = () => useRoomStore(useShallow((s) => s.skipVotes));
