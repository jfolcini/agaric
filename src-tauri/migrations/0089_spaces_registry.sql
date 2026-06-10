-- Issue #708: first-class `spaces` registry table — make `blocks.space_id`
-- an FK to `spaces(id)`, not `blocks(id)`.
--
-- Spaces are ~5 rows that almost never change, yet "is a space" had no
-- schema-level definition: `blocks.space_id REFERENCES blocks(id)` (0086)
-- could point at ANY block, so "the target is a real space" was a
-- per-call-site discipline (#612: two call sites don't enforce it), and the
-- bootstrap predicates drifted (#681). This migration adopts the hybrid
-- design from #708: the space's block row stays (name/content/history/sync
-- remain on the uniform pipeline) and a thin registry table sits over it.
--
--   * `spaces(id)` — one row per block that has ever been flagged
--     `is_space = 'true'`. `id REFERENCES blocks(id) ON DELETE CASCADE`:
--     hard-purging the space's block row removes the registry row.
--   * `blocks.space_id` is rebuilt as `REFERENCES spaces(id) ON DELETE
--     SET NULL`: stamping a membership with a non-space id is now an FK
--     violation (the #612 bug class is unrepresentable), and purging a
--     space gracefully NULLs surviving memberships (the every-boot
--     `pages_without_space` backfill, BUG-1/L-133, then reassigns them
--     to Personal).
--
-- Registry semantics — mirrors the `is_space` FLAG, not liveness:
--   * A soft-deleted space block KEEPS its registry row, exactly as it
--     keeps its `is_space` property row. "Live space" remains
--     `spaces JOIN blocks ... deleted_at IS NULL`, consistent with every
--     other liveness check. This also means historical `space_id` values
--     pointing at a tombstoned space stay valid (no data destroyed here).
--   * Registry rows are inserted by the `spaces_register_is_space` trigger
--     below whenever an `is_space = 'true'` property row lands. Every
--     space-creating path (create_space command, seeded-space bootstrap,
--     sync materialization, op-log recovery replay, snapshot restore)
--     writes that property row, so the trigger is the single registration
--     point — no Rust path can forget it (the #605 missed-call-site class).
--     A trigger (not a CHECK, cf. 0088's preference) because this is a
--     derivation, not a validation; like all triggers it must be re-created
--     if `block_properties` is ever rebuilt.
--   * Registry rows are only removed by the blocks-purge CASCADE. The
--     user-facing "delete space" flow soft-deletes the (empty) space block
--     and leaves the row, mirroring the surviving `is_space` property.
--
-- Backfill: every `block_properties(key='is_space', value_text='true')`
-- row (live AND soft-deleted — see above). `blocks.space_id` values whose
-- target is NOT in that set (historically mis-stamped via the #612 gap)
-- are NULLed; the boot backfill repairs them to Personal.
--
-- Mechanics — the `blocks` rebuild follows 0085's 12-step recipe with two
-- corrections mandated by #606 (DROP TABLE under foreign_keys=ON
-- IMMEDIATELY fires ON DELETE CASCADE on every child — the #376 harness
-- pins this):
--   1. The authoritative, non-recoverable children `page_aliases` (no
--      op-log entries, #110) and `block_drafts` (device-local) are copied
--      to `_preserve_*` tables before the DROP and restored after the
--      RENAME. Op-log-derived children (block_properties, block_tags,
--      attachments, caches) re-materialize at next boot via
--      `recover_derived_state_from_op_log`, as on every prior rebuild.
--   2. `spaces` is created EMPTY and populated only AFTER the RENAME, from
--      the `_spaces_backfill` snapshot taken up front. Were it populated
--      before the DROP, the implicit DELETE would cascade `blocks → spaces`
--      and then fire `spaces → _new_blocks.space_id ON DELETE SET NULL`,
--      silently wiping every membership we just copied. ANY FUTURE blocks
--      rebuild must preserve+restore `spaces` rows the same way, or
--      memberships are destroyed.
--
-- `PRAGMA defer_foreign_keys = ON` (in-repo precedent: `apply_snapshot`,
-- F02) defers FK *violation checks* to this migration tx's COMMIT —
-- required because `_new_blocks.space_id` rows are inserted while `spaces`
-- is still empty; the deferred violations resolve when `spaces` is
-- populated below. It does NOT defer CASCADE/SET NULL *actions*, hence the
-- empty-`spaces` choreography above. The pragma auto-resets at COMMIT.

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------
-- Pre-cleanup: NULL out orphaned self-referencing FK values before the
-- copy (mirrors 0073 / 0085).
-- ---------------------------------------------------------------------
UPDATE blocks SET parent_id = NULL
 WHERE parent_id IS NOT NULL
   AND parent_id NOT IN (SELECT id FROM blocks);

UPDATE blocks SET page_id = NULL
 WHERE page_id IS NOT NULL
   AND page_id NOT IN (SELECT id FROM blocks);

-- ---------------------------------------------------------------------
-- Snapshot the registry set up front (plain table, no FKs — it must
-- survive the DROP). `block_properties.block_id` REFERENCES blocks(id),
-- so every snapshotted id is an existing block.
-- ---------------------------------------------------------------------
CREATE TABLE _spaces_backfill (
    id TEXT NOT NULL PRIMARY KEY
) STRICT;

INSERT INTO _spaces_backfill (id)
SELECT block_id FROM block_properties
 WHERE key = 'is_space' AND value_text = 'true';

-- Orphan space refs (#612 class: space_id stamped with a non-space
-- block). NULL them so the rebuilt rows satisfy the new FK; the
-- every-boot backfill reassigns affected pages to Personal.
UPDATE blocks SET space_id = NULL
 WHERE space_id IS NOT NULL
   AND space_id NOT IN (SELECT id FROM _spaces_backfill);

-- ---------------------------------------------------------------------
-- #606: preserve the authoritative CASCADE children across the DROP.
-- ---------------------------------------------------------------------
CREATE TABLE _preserve_page_aliases (
    page_id TEXT NOT NULL,
    alias   TEXT NOT NULL
) STRICT;
INSERT INTO _preserve_page_aliases (page_id, alias)
SELECT page_id, alias FROM page_aliases;

CREATE TABLE _preserve_block_drafts (
    block_id   TEXT NOT NULL,
    content    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO _preserve_block_drafts (block_id, content, updated_at)
SELECT block_id, content, updated_at FROM block_drafts;

-- ---------------------------------------------------------------------
-- The registry. Created EMPTY here (see header); populated after the
-- RENAME below.
-- ---------------------------------------------------------------------
CREATE TABLE spaces (
    -- Room for later (#126, #708): sort order, archived flag,
    -- per-space settings.
    id TEXT NOT NULL PRIMARY KEY
        REFERENCES blocks(id) ON DELETE CASCADE
) STRICT;

-- ---------------------------------------------------------------------
-- Rebuild `blocks`: identical to the current (post-0086) schema except
-- `space_id` now REFERENCES spaces(id) ON DELETE SET NULL. Column order
-- unchanged so index-keyed bindings keep working.
-- ---------------------------------------------------------------------
CREATE TABLE _new_blocks (
    id             TEXT NOT NULL PRIMARY KEY,
    block_type     TEXT NOT NULL DEFAULT 'content',
    content        TEXT,
    parent_id      TEXT REFERENCES _new_blocks(id),
    position       INTEGER,
    -- milliseconds since UNIX epoch (UTC); NULL = live. Written via now_ms().
    deleted_at     INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
    todo_state     TEXT,
    priority       TEXT,
    due_date       TEXT,
    scheduled_date TEXT,
    page_id        TEXT REFERENCES _new_blocks(id),
    -- #708: membership now points at the registry, not at an arbitrary
    -- block. SET NULL (not RESTRICT) so purging a space block degrades
    -- gracefully: surviving members go space-less and the boot backfill
    -- reassigns them.
    space_id       TEXT REFERENCES spaces(id) ON DELETE SET NULL,
    CONSTRAINT page_id_self_for_pages CHECK (
        block_type != 'page' OR page_id = id
    ),
    CONSTRAINT block_type_valid CHECK (
        block_type IN ('content', 'tag', 'page')
    )
) STRICT;

-- Copy rows. `space_id` FK checks are deferred (spaces is still empty);
-- they resolve when the registry is populated below, before COMMIT.
INSERT INTO _new_blocks
    (id, block_type, content, parent_id, position, deleted_at,
     todo_state, priority, due_date, scheduled_date, page_id, space_id)
    SELECT id, block_type, content, parent_id, position, deleted_at,
           todo_state, priority, due_date, scheduled_date, page_id, space_id
    FROM blocks;

-- Drop the old table (cascades fire on every child — the preserved
-- tables above are the non-recoverable ones) and rename the new table
-- into place.
DROP TABLE blocks;
ALTER TABLE _new_blocks RENAME TO blocks;

-- ---------------------------------------------------------------------
-- Populate the registry (resolves the deferred `space_id` FK checks; the
-- `spaces.id → blocks(id)` FK is satisfied because every backfilled id is
-- a block id copied through the rebuild).
-- ---------------------------------------------------------------------
INSERT INTO spaces (id)
SELECT id FROM _spaces_backfill;

-- ---------------------------------------------------------------------
-- Restore the preserved children, then drop the scratch tables.
-- ---------------------------------------------------------------------
INSERT INTO page_aliases (page_id, alias)
SELECT page_id, alias FROM _preserve_page_aliases;

INSERT INTO block_drafts (block_id, content, updated_at)
SELECT block_id, content, updated_at FROM _preserve_block_drafts;

DROP TABLE _preserve_page_aliases;
DROP TABLE _preserve_block_drafts;
DROP TABLE _spaces_backfill;

-- ---------------------------------------------------------------------
-- Recreate every live index verbatim (current definitions as of 0086).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_blocks_deleted
    ON blocks(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_todo
    ON blocks(todo_state) WHERE todo_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_due
    ON blocks(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_scheduled
    ON blocks(scheduled_date) WHERE scheduled_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_page_alive
    ON blocks(id) WHERE block_type = 'page' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_parent_covering
    ON blocks(parent_id, deleted_at, position, id);
CREATE INDEX IF NOT EXISTS idx_blocks_page_id
    ON blocks(page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_journal_date
    ON blocks(content) WHERE block_type = 'page' AND content LIKE '____-__-__';
CREATE INDEX IF NOT EXISTS idx_blocks_type
    ON blocks(block_type, deleted_at, id);
CREATE INDEX IF NOT EXISTS idx_blocks_space_type
    ON blocks(space_id, block_type, deleted_at, id);

-- ---------------------------------------------------------------------
-- Single registration point: every path that flags a block as a space
-- writes the `is_space = 'true'` property row (set_property INSERT OR
-- REPLACE included — REPLACE re-fires AFTER INSERT).
--
-- Idempotency lives in the WHEN clause (`NOT EXISTS`), NOT in an
-- `INSERT OR IGNORE` body. This is load-bearing: SQLite replaces the
-- conflict policy of statements inside a trigger body with the OUTER
-- statement's policy (https://sqlite.org/lang_createtrigger.html), so an
-- outer `INSERT OR REPLACE INTO block_properties` (the set_property
-- UPSERT shape) would turn a body-level `OR IGNORE` into `OR REPLACE` —
-- and a REPLACE on the spaces PK deletes + re-inserts the row, firing
-- `blocks.space_id ON DELETE SET NULL` and silently wiping every
-- membership in that space. The NOT EXISTS guard means the body INSERT
-- can never hit a conflict in the first place.
-- ---------------------------------------------------------------------
CREATE TRIGGER spaces_register_is_space
AFTER INSERT ON block_properties
WHEN NEW.key = 'is_space' AND NEW.value_text = 'true'
     AND NOT EXISTS (SELECT 1 FROM spaces WHERE id = NEW.block_id)
BEGIN
    INSERT INTO spaces (id) VALUES (NEW.block_id);
END;
