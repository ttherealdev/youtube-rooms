-- playercn — generic media sources, co-host role, and room lifecycle.
--
-- Three independent changes ship together because they are all breaking and a
-- half-applied subset leaves the room protocol inconsistent with the schema:
--
--   1. `moderator` becomes `cohost`, matching the product vocabulary.
--   2. A queue item is any playable source, not only a YouTube video id.
--   3. Rooms track a permanent owner, a designated successor, and the instant
--      they became empty, which is what the auto-close sweep runs on.

-- ---------------------------------------------------------------------------
-- 1. moderator -> cohost
-- ---------------------------------------------------------------------------

-- The CHECK has to go first: the UPDATE would otherwise violate it mid-flight.
ALTER TABLE room_members DROP CONSTRAINT room_members_role_check;

UPDATE room_members SET role = 'cohost' WHERE role = 'moderator';

ALTER TABLE room_members ADD CONSTRAINT room_members_role_check
    CHECK (role IN ('host', 'cohost', 'member', 'guest'));

-- ---------------------------------------------------------------------------
-- 2. Generic media sources
-- ---------------------------------------------------------------------------

-- A queue item now names *how* to play it. `youtube` keeps the embed path;
-- everything else is a URL handed to a media element, so the 11-character
-- video id stops being the identity of a row.
ALTER TABLE queue_items
    ADD COLUMN source_kind text NOT NULL DEFAULT 'youtube'
        CHECK (source_kind IN ('youtube', 'file', 'hls', 'dash')),
    ADD COLUMN source_url  text NOT NULL DEFAULT '';

-- Existing rows are all YouTube; give them a canonical URL so `source_url` is
-- meaningful for every row regardless of kind.
UPDATE queue_items
   SET source_url = 'https://www.youtube.com/watch?v=' || video_id
 WHERE source_url = '';

ALTER TABLE queue_items DROP CONSTRAINT queue_items_video_id_check;
ALTER TABLE queue_items ALTER COLUMN video_id DROP NOT NULL;

-- The identity rule the application relies on: a YouTube row always has a
-- well-formed video id, and any other row always has a URL to play.
ALTER TABLE queue_items ADD CONSTRAINT queue_items_source_identity CHECK (
    (source_kind = 'youtube' AND video_id IS NOT NULL AND char_length(video_id) = 11)
    OR
    (source_kind <> 'youtube' AND char_length(source_url) > 0)
);

-- Watch history and bookmarks reference a video by id too. They are personal
-- records rather than playback state, so they only need to stop assuming
-- YouTube; a source kind is enough.
ALTER TABLE watch_history
    ADD COLUMN source_kind text NOT NULL DEFAULT 'youtube'
        CHECK (source_kind IN ('youtube', 'file', 'hls', 'dash')),
    ADD COLUMN source_url  text NOT NULL DEFAULT '';

ALTER TABLE bookmarks
    ADD COLUMN source_kind text NOT NULL DEFAULT 'youtube'
        CHECK (source_kind IN ('youtube', 'file', 'hls', 'dash')),
    ADD COLUMN source_url  text NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- 3. Room ownership and lifecycle
-- ---------------------------------------------------------------------------

-- `host_id` is who controls the room *right now* and moves as the room changes
-- hands. `owner_id` is who created it and never moves, which is what lets a
-- returning creator reclaim the room they walked away from.
ALTER TABLE rooms ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE SET NULL;
UPDATE rooms SET owner_id = host_id WHERE owner_id IS NULL;

-- Who the host has nominated to take over when they leave. Advisory: if the
-- successor is not present at the time, the usual promotion order applies.
ALTER TABLE rooms ADD COLUMN successor_id uuid REFERENCES users (id) ON DELETE SET NULL;

-- Set when the last participant disconnects and cleared the moment anyone
-- rejoins. The auto-close sweep deletes rooms that have been empty longer than
-- the grace period, so a host refreshing the page cannot destroy their room.
ALTER TABLE rooms ADD COLUMN empty_since timestamptz;

-- Drives the sweep. Partial, because a room with anyone in it is never a
-- candidate and the index should not carry the whole table.
CREATE INDEX rooms_empty_since_idx
    ON rooms (empty_since)
    WHERE empty_since IS NOT NULL AND deleted_at IS NULL;

-- A closed room must leave the directory immediately, so every directory index
-- already filters on `deleted_at IS NULL`. Nothing to add there.

-- ---------------------------------------------------------------------------
-- 4. Settings defaults
-- ---------------------------------------------------------------------------

-- The theme is now a key into the shared theme registry rather than a one-off
-- name, and rooms gain a per-room appearance the host controls.
ALTER TABLE rooms ALTER COLUMN settings SET DEFAULT '{
    "allowGuestControl": false,
    "allowGuestQueue": true,
    "voteSkipRatio": 0.5,
    "autoAdvance": true,
    "shuffle": false,
    "theme": "default",
    "themeMode": "dark"
}'::jsonb;

-- Existing rooms carry the old "midnight" name, which no longer resolves.
UPDATE rooms
   SET settings = settings || '{"theme": "default", "themeMode": "dark"}'::jsonb
 WHERE settings ->> 'theme' IS NULL OR settings ->> 'theme' = 'midnight';

-- ---------------------------------------------------------------------------
-- 5. System chat kinds
-- ---------------------------------------------------------------------------

-- Promotions and the automatic host handover are announced in the room, so the
-- generated-message vocabulary grows with them.
ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_system_kind_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_system_kind_check CHECK (
    system_kind IS NULL OR system_kind IN (
        'join', 'leave', 'skip', 'host_changed', 'video_changed',
        'role_changed', 'room_closing', 'settings_changed'
    )
);
