-- Issue #541: promote the `block_type` enum guard from the two BEFORE
-- INSERT/UPDATE triggers (`check_block_type_insert` / `_update`, migration
-- 0005) into a storage-layer CHECK constraint via a `blocks` table rebuild.
--
-- Background: 0005 used triggers because SQLite has no
-- `ALTER TABLE ... ADD CHECK`. The cost is procedural, not structural —
-- every future `blocks` rebuild must remember to recreate the triggers
-- (0073 did; a missed recreation would silently drop the guard). A native
-- CHECK survives table rebuilds automatically and removes that per-migration
-- vigilance tax. SQLite has supported CHECK constraints since long before the
-- 3.38+ this app targets, so the trigger workaround is no longer warranted.
--
-- Mechanics: the canonical 12-step table-rebuild recipe (in-repo precedent:
-- migrations 0061 / 0062 / 0073; spec at
-- https://www.sqlite.org/lang_altertable.html). `blocks` is the FK parent for
-- ~14 referencing tables, so the rebuild relies on SQLite's commit-time
-- foreign-key validation: between the DROP and the RENAME the schema is
-- briefly in a "FK target missing" state, but no DML runs in that window and
-- the renamed `_new_blocks` carries the identical row set, so every
-- referencing FK re-resolves by name at the migration tx's commit. sqlx wraps
-- each migration in its own tx, so `PRAGMA foreign_keys` cannot be toggled
-- here (the pragma is a no-op inside a tx); `foreign_keys = ON` from
-- `init_pool` stays in effect. This is safe because the bulk copy is a pure
-- `INSERT ... SELECT` (no rows deleted from `blocks`), so referencing FK rows
-- keep pointing at valid ids throughout.
--
-- The new table mirrors the CURRENT `blocks` schema exactly — i.e. post-0073
-- (`page_id_self_for_pages` CHECK) and post-0080 (`deleted_at` is INTEGER ms
-- with its `>= 0` CHECK) — with one addition: the `block_type_valid` CHECK.
-- Column order is unchanged so existing index-keyed `query_as!` / `FromRow`
-- bindings (`BlockRow`, the `SELECT … FROM blocks` sites in
-- `commands/blocks/crud.rs`) keep working. STRICT per migrations/AGENTS.md.
--
-- The two 0005 triggers are intentionally NOT recreated — the CHECK replaces
-- them. Behaviour change: an invalid `block_type` written via a raw SQL path
-- now aborts with `CHECK constraint failed: block_type_valid` instead of the
-- trigger's `RAISE(ABORT, 'invalid block_type: …')`. No production code path
-- depends on the message (command-layer `create_block` validates block_type in
-- Rust and returns `AppError::Validation` before reaching SQL); the only test
-- that exercises the raw-SQL guard (`apply_snapshot_rejects_invalid_block_type`)
-- asserts `is_err()`, which the CHECK still satisfies.
--
-- The 9 live indexes (current definitions as of 0083) are recreated verbatim.
--
-- Audit predicate (body of the new CHECK):
--   SELECT COUNT(*) FROM blocks WHERE block_type NOT IN ('content','tag','page');
-- On every steady-state database this is 0 and the bulk copy succeeds. A
-- stray value aborts the migration with the original `blocks` intact
-- (fail-loud-and-safe); the operator repairs the row and re-runs.

-- ---------------------------------------------------------------------
-- Pre-cleanup: NULL out orphaned self-referencing FK values before the
-- copy (mirrors 0073). The bulk INSERT re-validates `parent_id` /
-- `page_id` row-by-row under `foreign_keys = ON`; any historical
-- dangling pointer must be cleaned first. NULL is safe (NULL FKs skip
-- validation; the page_id CHECK only fires on `block_type = 'page'`
-- rows, whose `page_id` is always `id`).
-- ---------------------------------------------------------------------
UPDATE blocks SET parent_id = NULL
 WHERE parent_id IS NOT NULL
   AND parent_id NOT IN (SELECT id FROM blocks);

UPDATE blocks SET page_id = NULL
 WHERE page_id IS NOT NULL
   AND page_id NOT IN (SELECT id FROM blocks);

-- ---------------------------------------------------------------------
-- Create the new table: current schema + the `block_type_valid` CHECK.
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
    CONSTRAINT page_id_self_for_pages CHECK (
        block_type != 'page' OR page_id = id
    ),
    CONSTRAINT block_type_valid CHECK (
        block_type IN ('content', 'tag', 'page')
    )
) STRICT;

-- ---------------------------------------------------------------------
-- Copy rows. Both CHECK constraints fire per-row; a violation aborts with the
-- original `blocks` intact.
-- ---------------------------------------------------------------------
INSERT INTO _new_blocks
    (id, block_type, content, parent_id, position, deleted_at,
     todo_state, priority, due_date, scheduled_date, page_id)
    SELECT id, block_type, content, parent_id, position, deleted_at,
           todo_state, priority, due_date, scheduled_date, page_id
    FROM blocks;

-- ---------------------------------------------------------------------
-- Drop the old table (also drops its indexes and the two 0005
-- block_type triggers) and rename the new table into place.
-- ---------------------------------------------------------------------
DROP TABLE blocks;
ALTER TABLE _new_blocks RENAME TO blocks;

-- ---------------------------------------------------------------------
-- Recreate every live index verbatim (current definitions as of 0083).
-- The two block_type triggers are deliberately NOT recreated — the
-- `block_type_valid` CHECK supersedes them.
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
