import { z } from 'zod';
import {
  displayName,
  roomCategory,
  roomVisibility,
  userSummary,
  uuid,
  videoId,
} from './primitives.ts';

/**
 * Request/response shapes for the HTTP API.
 *
 * Mirrors the `serde` DTOs in `apps/server/src/rooms/routes.rs` and
 * `apps/server/src/auth/routes.rs`.
 */

export const guestLoginRequest = z.object({
  displayName,
});

export const sessionResponse = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires; the client refreshes at 80% of this. */
  expiresIn: z.number().int().positive(),
  user: userSummary,
});
export type SessionResponse = z.infer<typeof sessionResponse>;

export const createRoomRequest = z.object({
  name: z.string().trim().min(2).max(60),
  topic: z.string().trim().max(200).optional(),
  visibility: roomVisibility.default('private'),
  category: roomCategory.default('general'),
  /** Optional room password; hashed with Argon2id server-side, never stored raw. */
  password: z.string().min(4).max(128).optional(),
  maxParticipants: z.number().int().min(2).max(100).default(25),
  allowGuestControl: z.boolean().default(false),
  allowGuestQueue: z.boolean().default(true),
  /** Seed the queue at creation time — used by room templates. */
  initialVideoIds: z.array(videoId).max(50).default([]),
});
export type CreateRoomRequest = z.infer<typeof createRoomRequest>;

export const updateRoomRequest = createRoomRequest.partial().extend({
  voteSkipRatio: z.number().min(0).max(1).optional(),
  autoAdvance: z.boolean().optional(),
  theme: z.string().max(32).optional(),
  /** Explicit null clears the password; omitted leaves it unchanged. */
  password: z.string().min(4).max(128).nullable().optional(),
});

export const joinRoomRequest = z.object({
  password: z.string().max(128).optional(),
  inviteCode: z.string().max(64).optional(),
});

export const roomListItem = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  topic: z.string().nullable(),
  category: roomCategory,
  host: userSummary,
  participantCount: z.number().int().min(0),
  maxParticipants: z.number().int().positive(),
  hasPassword: z.boolean(),
  nowPlaying: z
    .object({
      videoId,
      title: z.string(),
      thumbnailUrl: z.url(),
    })
    .nullable(),
  createdAt: z.number().int(),
  /** Composite ranking score; see docs/architecture.md#directory-ranking. */
  trendingScore: z.number(),
});
export type RoomListItem = z.infer<typeof roomListItem>;

export const roomListQuery = z.object({
  sort: z.enum(['trending', 'newest', 'active']).default('trending'),
  category: roomCategory.optional(),
  q: z.string().max(80).optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});
export type RoomListQuery = z.infer<typeof roomListQuery>;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export const videoSearchResult = z.object({
  videoId,
  title: z.string(),
  channelTitle: z.string(),
  durationSeconds: z.number().int().min(0),
  thumbnailUrl: z.url(),
  viewCount: z.number().int().min(0).nullable(),
  publishedAt: z.number().int().nullable(),
});
export type VideoSearchResult = z.infer<typeof videoSearchResult>;

export const watchHistoryEntry = z.object({
  videoId,
  title: z.string(),
  thumbnailUrl: z.url(),
  roomId: uuid.nullable(),
  roomName: z.string().nullable(),
  watchedAt: z.number().int(),
  /** Where the user stopped, powering "continue watching". */
  positionSeconds: z.number().min(0),
  durationSeconds: z.number().int().min(0),
});

export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Field-level messages for form validation failures. */
    fields: z.record(z.string(), z.string()).optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiError>;
