import { z } from 'zod';

/**
 * Shared scalars. Every constraint here is also enforced server-side in Rust —
 * these schemas exist to fail fast at the client boundary and to document the
 * contract, never as the only line of defence.
 */

export const uuid = z.uuid();

/** YouTube video IDs are exactly 11 characters from the URL-safe base64 set. */
export const videoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/, 'not a valid YouTube video id');

export const roomSlug = z
  .string()
  .regex(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/, 'not a valid room code');

export const displayName = z.string().trim().min(2).max(32);

export const chatBody = z.string().trim().min(1).max(2000);

/** Milliseconds since the Unix epoch, as measured by the server. */
export const epochMs = z.number().int();

/** Playback position in seconds; fractional. */
export const seconds = z.number().min(0).finite();

/** YouTube supports a fixed ladder; anything else is rejected. */
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const playbackRate = z.union(
  PLAYBACK_RATES.map((r) => z.literal(r)) as unknown as [
    z.ZodLiteral<number>,
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ],
);

export const roomRole = z.enum(['host', 'moderator', 'member', 'guest']);
export type RoomRole = z.infer<typeof roomRole>;

export const roomVisibility = z.enum(['public', 'private', 'unlisted']);
export type RoomVisibility = z.infer<typeof roomVisibility>;

export const roomCategory = z.enum([
  'general',
  'anime',
  'gaming',
  'programming',
  'music',
  'movies',
  'education',
]);
export type RoomCategory = z.infer<typeof roomCategory>;

export const accountKind = z.enum(['google', 'guest']);
export type AccountKind = z.infer<typeof accountKind>;

export const permissions = z.object({
  canControlPlayback: z.boolean(),
  canManageQueue: z.boolean(),
  canInvite: z.boolean(),
  canKick: z.boolean(),
  canModerateChat: z.boolean(),
  canEditRoom: z.boolean(),
});
export type Permissions = z.infer<typeof permissions>;

export const userSummary = z.object({
  id: uuid,
  displayName,
  avatarUrl: z.url().nullable(),
  /** Deterministic initials fallback, e.g. "AM" for "Anas Mohamed". */
  initials: z.string().min(1).max(2),
  /** Hue in degrees, derived from the id, for the generated gradient avatar. */
  avatarHue: z.number().int().min(0).max(359),
  kind: accountKind,
});
export type UserSummary = z.infer<typeof userSummary>;

export const participant = z.object({
  user: userSummary,
  role: roomRole,
  joinedAt: epochMs,
  /** Present in the voice session (not necessarily unmuted). */
  inVoice: z.boolean(),
  muted: z.boolean(),
  /** Last drift sample this client reported, in ms. Null until first report. */
  driftMs: z.number().nullable(),
});
export type Participant = z.infer<typeof participant>;

export const queueItem = z.object({
  id: uuid,
  videoId,
  title: z.string(),
  channelTitle: z.string(),
  durationSeconds: z.number().int().min(0),
  thumbnailUrl: z.url(),
  addedBy: userSummary,
  addedAt: epochMs,
  /** Fractional index, so a reorder writes one row instead of renumbering. */
  position: z.number(),
});
export type QueueItem = z.infer<typeof queueItem>;

export const chatMessage = z.object({
  id: uuid,
  author: userSummary,
  body: chatBody,
  sentAt: epochMs,
  editedAt: epochMs.nullable(),
  replyTo: uuid.nullable(),
  pinned: z.boolean(),
  /** Client-generated id, echoed back so optimistic messages can be replaced. */
  nonce: z.string().max(64).nullable(),
  mentions: z.array(uuid),
  /** Populated for system messages such as joins, skips and ownership changes. */
  system: z.enum(['join', 'leave', 'skip', 'host_changed', 'video_changed']).nullable(),
});
export type ChatMessage = z.infer<typeof chatMessage>;

export const iceServer = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServer>;
