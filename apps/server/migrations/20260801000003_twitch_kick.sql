-- Twitch and Kick as playable sources.
--
-- Both are live-first platforms that only play inside their own embed, so they
-- are their own kinds rather than another flavour of `hls`: the client has to
-- pick a completely different engine for each, and `may_be_live` has to be true
-- for both so the room never tries to auto-advance off the end of a stream that
-- has no end.
--
-- The inline CHECK constraints created by `ADD COLUMN ... CHECK (...)` get
-- generated names, so each is dropped by the name Postgres assigned before the
-- widened version is added under an explicit one.

ALTER TABLE queue_items DROP CONSTRAINT IF EXISTS queue_items_source_kind_check;
ALTER TABLE queue_items ADD CONSTRAINT queue_items_source_kind_check
    CHECK (source_kind IN ('youtube', 'file', 'hls', 'dash', 'twitch', 'kick'));

ALTER TABLE watch_history DROP CONSTRAINT IF EXISTS watch_history_source_kind_check;
ALTER TABLE watch_history ADD CONSTRAINT watch_history_source_kind_check
    CHECK (source_kind IN ('youtube', 'file', 'hls', 'dash', 'twitch', 'kick'));

ALTER TABLE bookmarks DROP CONSTRAINT IF EXISTS bookmarks_source_kind_check;
ALTER TABLE bookmarks ADD CONSTRAINT bookmarks_source_kind_check
    CHECK (source_kind IN ('youtube', 'file', 'hls', 'dash', 'twitch', 'kick'));
