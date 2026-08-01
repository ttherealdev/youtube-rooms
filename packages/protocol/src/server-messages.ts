import { z } from 'zod';
import {
  chatMessage,
  iceServer,
  participant,
  permissions,
  queueItem,
  roomCategory,
  roomRole,
  roomVisibility,
  userSummary,
  uuid,
} from './primitives.ts';
import { timeline } from './timeline.ts';

/** Room metadata as delivered over the socket (the REST shape is richer). */
export const roomSnapshot = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  topic: z.string().nullable(),
  visibility: roomVisibility,
  category: roomCategory,
  /** Who controls the room right now; moves when it changes hands. */
  hostId: uuid,
  /**
   * Who created it. Never moves on an automatic handover, which is what lets a
   * returning creator reclaim a room that was passed on while they were away.
   */
  ownerId: uuid.nullable(),
  /** Who the host nominated to inherit the room. */
  successorId: uuid.nullable(),
  createdAt: z.number().int(),
  maxParticipants: z.number().int().positive(),
  /** Non-host playback control, vote-skip threshold, etc. */
  settings: z.object({
    allowGuestControl: z.boolean(),
    allowGuestQueue: z.boolean(),
    voteSkipRatio: z.number().min(0).max(1),
    autoAdvance: z.boolean(),
    shuffle: z.boolean(),
    /** Theme key every client in the room renders with. Host-controlled. */
    theme: z.string(),
    themeMode: z.enum(['light', 'dark']),
  }),
});
export type RoomSnapshot = z.infer<typeof roomSnapshot>;

/**
 * Sent once, immediately after a successful `authenticate`, and again after
 * every reconnect. It is a *complete* picture — there is no delta replay,
 * because a full snapshot is small and idempotent (ADR 0004).
 */
const ready = z.object({
  t: z.literal('ready'),
  self: userSummary,
  role: roomRole,
  permissions,
  room: roomSnapshot,
  timeline,
  participants: z.array(participant),
  queue: z.array(queueItem),
  /** Most recent messages, oldest first. Older pages come from REST. */
  recentMessages: z.array(chatMessage),
  pinnedMessages: z.array(chatMessage),
  iceServers: z.array(iceServer),
  /** Server clock at send. Seeds the offset estimate before the first ping lands. */
  serverTime: z.number().int(),
});

const pong = z.object({
  t: z.literal('pong'),
  /** Echoed verbatim so the client can match the sample and compute RTT. */
  clientSent: z.number(),
  /** Stamped as late as possible in the handler to minimise server-side skew. */
  serverTime: z.number(),
});

const timelineUpdate = z.object({
  t: z.literal('timeline'),
  timeline,
  /** Who caused this, for the "Sam skipped ahead" toast. Null for server actions. */
  actor: userSummary.nullable(),
  reason: z.enum(['intent', 'advance', 'vote_skip']),
});

const participantJoined = z.object({ t: z.literal('participant_joined'), participant });
const participantLeft = z.object({ t: z.literal('participant_left'), userId: uuid });
const participantUpdated = z.object({ t: z.literal('participant_updated'), participant });

const queueUpdated = z.object({
  t: z.literal('queue_updated'),
  items: z.array(queueItem),
  version: z.number().int(),
});

const chatMessageEvent = z.object({ t: z.literal('chat_message'), message: chatMessage });
const chatTypingEvent = z.object({
  t: z.literal('chat_typing'),
  userId: uuid,
  active: z.boolean(),
});
const chatPinnedEvent = z.object({
  t: z.literal('chat_pinned'),
  message: chatMessage,
  pinned: z.boolean(),
});
const chatReadEvent = z.object({
  t: z.literal('chat_read'),
  userId: uuid,
  throughMessageId: uuid,
});

const reactionEvent = z.object({
  t: z.literal('reaction'),
  userId: uuid,
  emoji: z.string(),
  /** Server timestamp, so bursts from different clients animate in real order. */
  at: z.number().int(),
});

const skipVoteUpdate = z.object({
  t: z.literal('skip_vote_update'),
  votes: z.number().int().min(0),
  needed: z.number().int().min(0),
  voters: z.array(uuid),
});

const voicePeerJoined = z.object({
  t: z.literal('voice_peer_joined'),
  userId: uuid,
  /** Perfect-negotiation role, decided server-side so the two peers cannot disagree. */
  polite: z.boolean(),
});
const voicePeerLeft = z.object({ t: z.literal('voice_peer_left'), userId: uuid });
const voiceSignalEvent = z.object({
  t: z.literal('voice_signal'),
  from: uuid,
  payload: z.unknown(),
});
const voiceStateEvent = z.object({
  t: z.literal('voice_state'),
  userId: uuid,
  muted: z.boolean(),
  inVoice: z.boolean(),
});
/** Emitted when the room crosses VOICE_MESH_MAX_PEERS (ADR 0006). */
const voiceCapacity = z.object({
  t: z.literal('voice_capacity'),
  atCapacity: z.boolean(),
  maxPeers: z.number().int(),
});

const roomUpdated = z.object({ t: z.literal('room_updated'), room: roomSnapshot });
const permissionsUpdated = z.object({
  t: z.literal('permissions_updated'),
  role: roomRole,
  permissions,
});

const kicked = z.object({
  t: z.literal('kicked'),
  reason: z.enum(['room_closed', 'banned']),
});

const errorMessage = z.object({
  t: z.literal('error'),
  code: z.enum([
    'unauthenticated',
    'forbidden',
    'rate_limited',
    'invalid_message',
    'stale_version',
    'room_full',
    'not_found',
    'internal',
  ]),
  message: z.string(),
  /** Present on rate_limited: when the client may retry. */
  retryAfterMs: z.number().int().optional(),
});

export const serverMessage = z.discriminatedUnion('t', [
  ready,
  pong,
  timelineUpdate,
  participantJoined,
  participantLeft,
  participantUpdated,
  queueUpdated,
  chatMessageEvent,
  chatTypingEvent,
  chatPinnedEvent,
  chatReadEvent,
  reactionEvent,
  skipVoteUpdate,
  voicePeerJoined,
  voicePeerLeft,
  voiceSignalEvent,
  voiceStateEvent,
  voiceCapacity,
  roomUpdated,
  permissionsUpdated,
  kicked,
  errorMessage,
]);

export type ServerMessage = z.infer<typeof serverMessage>;
export type ServerMessageType = ServerMessage['t'];

/** Narrowing helper so consumers get a typed payload from a `t` value. */
export type ServerMessageOf<K extends ServerMessageType> = Extract<ServerMessage, { t: K }>;
