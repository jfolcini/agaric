-- #2292: durable tombstone of a purge delta's purged block-id set, so a
-- crash between the engine import and the (uncommitted) SQL Pass-D sweep is
-- re-swept on recovery. NULL for non-purge imports. JSON array of block ids.
ALTER TABLE loro_sync_inbox ADD COLUMN purged_ids TEXT;
