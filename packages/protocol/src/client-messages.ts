import { z } from 'zod';
import { chatBody, playbackRate, seconds, uuid, videoId } from './primitives.ts';

/**
 * Messages the browser sends. Every one of these is an *intent* — the server
 * validates permission, decides the outcome against its own clock, and
 * broadcasts the result. Nothing here is applied locally before the echo
 * arrives (ADR 0005 §4).
 */

const authenticate = z.object({
  t: z.literal('authenticate'),
  /** Single-use ticket from POST /api/auth/ws-ticket. Never a bearer token. */
  ticket: z.string().min(16).max(512),
});

const ping = z.object({
  t: z.literal('ping'),
  /** Client's `performance.timeOrigin + performance.now()` at send. */
  clientSent: z.number(),
});

const syncIntent = z.object({
  t: z.literal('sync_intent'),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('play') }),
    z.object({ kind: z.literal('pause') }),
    z.object({ kind: z.literal('seek'), position: seconds }),
    z.object({ kind: z.literal('set_rate'), rate: playbackRate }),
    z.object({ kind: z.literal('set_loop'), loop: z.boolean() }),
    z.object({ kind: z.literal('play_now'), queueItemId: uuid }),
    z.object({ kind: z.literal('next') }),
    z.object({ kind: z.literal('previous') }),
    z.object({ kind: z.literal('restart') }),
  ]),
  /** Timeline version the client believed it was acting on; stale intents are dropped. */
  version: z.number().int().min(0),
});

const syncReport = z.object({
  t: z.literal('sync_report'),
  /** Signed: positive means the client is ahead of the authoritative position. */
  driftMs: z.number(),
  position: seconds,
  buffering: z.boolean(),
});

const queueAdd = z.object({
  t: z.literal('queue_add'),
  videoId,
  /** Insert next rather than at the tail. Requires queue permission. */
  playNext: z.boolean().default(false),
});

const queueRemove = z.object({ t: z.literal('queue_remove'), itemId: uuid });

const queueMove = z.object({
  t: z.literal('queue_move'),
  itemId: uuid,
  /** Target index in the *current* ordering; server resolves to a fractional position. */
  toIndex: z.number().int().min(0),
});

const queueClear = z.object({ t: z.literal('queue_clear') });
const queueShuffle = z.object({ t: z.literal('queue_shuffle') });

const chatSend = z.object({
  t: z.literal('chat_send'),
  body: chatBody,
  replyTo: uuid.nullable().default(null),
  /** Echoed back so the optimistic bubble can be reconciled rather than duplicated. */
  nonce: z.string().max(64),
});

const chatTyping = z.object({ t: z.literal('chat_typing'), active: z.boolean() });
const chatPin = z.object({ t: z.literal('chat_pin'), messageId: uuid, pinned: z.boolean() });
const chatRead = z.object({ t: z.literal('chat_read'), throughMessageId: uuid });

const reactionSend = z.object({
  t: z.literal('reaction_send'),
  /** Constrained set — arbitrary strings here would be an XSS vector in the burst layer. */
  emoji: z.enum(['❤️', '😂', '🔥', '😮', '👏', '💀', '🎉', '👀']),
});

const skipVote = z.object({ t: z.literal('skip_vote'), voting: z.boolean() });

const voiceJoin = z.object({ t: z.literal('voice_join') });
const voiceLeave = z.object({ t: z.literal('voice_leave') });

const voiceSignal = z.object({
  t: z.literal('voice_signal'),
  /** Target peer. The server relays verbatim after checking both are in the room. */
  to: uuid,
  payload: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('offer'), sdp: z.string().max(64_000) }),
    z.object({ kind: z.literal('answer'), sdp: z.string().max(64_000) }),
    z.object({
      kind: z.literal('candidate'),
      candidate: z.string().max(4096),
      sdpMid: z.string().nullable(),
      sdpMLineIndex: z.number().int().nullable(),
    }),
  ]),
});

const voiceState = z.object({
  t: z.literal('voice_state'),
  muted: z.boolean(),
});

const kickParticipant = z.object({ t: z.literal('kick_participant'), userId: uuid });
const setRole = z.object({
  t: z.literal('set_role'),
  userId: uuid,
  role: z.enum(['moderator', 'member']),
});
const transferHost = z.object({ t: z.literal('transfer_host'), userId: uuid });

export const clientMessage = z.discriminatedUnion('t', [
  authenticate,
  ping,
  syncIntent,
  syncReport,
  queueAdd,
  queueRemove,
  queueMove,
  queueClear,
  queueShuffle,
  chatSend,
  chatTyping,
  chatPin,
  chatRead,
  reactionSend,
  skipVote,
  voiceJoin,
  voiceLeave,
  voiceSignal,
  voiceState,
  kickParticipant,
  setRole,
  transferHost,
]);

export type ClientMessage = z.infer<typeof clientMessage>;
export type ClientMessageType = ClientMessage['t'];
