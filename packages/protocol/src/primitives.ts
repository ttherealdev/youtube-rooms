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

export const roomRole = z.enum(['host', 'cohost', 'member', 'guest']);
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

/**
 * `system` is not a real account. It is the synthetic author the server
 * attaches to messages with no `author_id` — joins, skips, host changes — and
 * it therefore appears in `recentMessages` and `pinnedMessages`. Omitting it
 * makes every snapshot containing a system message fail validation, and the
 * client discards unparseable frames silently.
 */
export const accountKind = z.enum(['google', 'guest', 'system']);
export type AccountKind = z.infer<typeof accountKind>;

export const permissions = z.object({
  canControlPlayback: z.boolean(),
  canManageQueue: z.boolean(),
  canInvite: z.boolean(),
  canKick: z.boolean(),
  canModerateChat: z.boolean(),
  canEditRoom: z.boolean(),
  canVoteSkip: z.boolean(),
  canTransferHost: z.boolean(),
  /** Promote a member to co-host, or demote one. Host-only. */
  canManageRoles: z.boolean(),
  canDesignateSuccessor: z.boolean(),
  canSetRoomTheme: z.boolean(),
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

/**
 * How a source is played.
 *
 * The server decides this once, from the URL, so every client agrees on the
 * playback strategy instead of re-sniffing the link. `youtube` goes through the
 * IFrame API; `file` is a bare media element; `hls` and `dash` need Media
 * Source Extensions.
 */
export const sourceKind = z.enum(['youtube', 'file', 'hls', 'dash', 'twitch', 'kick']);
export type SourceKind = z.infer<typeof sourceKind>;

export const mediaSource = z.object({
  kind: sourceKind,
  url: z.url(),
  /** Present for, and only for, `youtube`. */
  videoId: videoId.nullable(),
});
export type MediaSource = z.infer<typeof mediaSource>;

/**
 * Live sources have no end to seek to, so the UI hides the scrubber.
 *
 * Twitch is included even though it also serves VODs: a channel URL and a VOD
 * URL have the same effect on the room, and offering a seek bar for a live
 * channel is a worse failure than withholding one from a VOD.
 */
export function mayBeLive(source: MediaSource): boolean {
  return (
    source.kind === 'hls' ||
    source.kind === 'dash' ||
    source.kind === 'twitch' ||
    source.kind === 'kick'
  );
}

export const queueItem = z.object({
  id: uuid,
  source: mediaSource,
  title: z.string(),
  channelTitle: z.string(),
  /** Zero when unknown — true for every file and stream until one plays. */
  durationSeconds: z.number().int().min(0),
  /** Empty for sources with no artwork, e.g. most playlist imports. */
  thumbnailUrl: z.union([z.url(), z.literal('')]),
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
  system: z
    .enum([
      'join',
      'leave',
      'skip',
      'host_changed',
      'video_changed',
      'role_changed',
      'room_closing',
      'settings_changed',
    ])
    .nullable(),
});
export type ChatMessage = z.infer<typeof chatMessage>;

export const iceServer = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServer>;
