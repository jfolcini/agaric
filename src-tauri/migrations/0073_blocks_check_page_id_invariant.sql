-- Issue #111 (sql-review-2026-05-27): promote the "every `block_type =
-- 'page'` row carries `page_id = id`" invariant from a Rust-side
-- write-time check into a storage-layer CHECK constraint via a `blocks`
-- table rebuild.
--
-- Background: migration 0066 backfilled `page_id = id` for every
-- existing page row and noted in its own comment (lines 37-43) that the
-- CHECK promotion would require a `blocks` rebuild and was DEFERRED
-- because the invariant was enforced upstream in Rust at write time.
-- Issue #111 reopens that decision: at least one write site
-- (`apply_create_block_sql_only`) skipped the Rust enforcement, and any
-- future write path bypassing `create_block_in_tx` would silently
-- regress without a schema-level guard. Pushing the invariant into the
-- schema removes the per-PR vigilance tax permanently.
--
-- Mechanics: SQLite has no `ALTER TABLE ... ADD CONSTRAINT`, so this is
-- the canonical 12-step table-rebuild recipe (in-repo precedent:
-- migrations 0061 and 0062; spec at
-- https://www.sqlite.org/lang_altertable.html). `blocks` is the FK
-- parent for ~14 referencing tables, so the rebuild relies on SQLite's
-- commit-time foreign-key validation: between the DROP and the RENAME
-- the schema is briefly in a "FK target missing" state, but no data
-- manipulation runs during that window, and at the migration tx's
-- commit the renamed `_new_blocks` is back in place with the same row
-- set so every referencing FK re-resolves by name. sqlx wraps each
-- migration in its own tx so `PRAGMA foreign_keys` cannot be toggled
-- inside this file (the pragma is a no-op inside a tx); the
-- `foreign_keys = ON` setting from `init_pool` therefore remains in
-- effect for the duration of the migration. This is acceptable because
-- (a) no row references a *missing* block id at the start (every
-- referencing table was CASCADE-rebuilt in 0061 against a clean
-- `blocks` table), (b) the rebuild does not delete any rows in `blocks`
-- itself — `INSERT INTO _new_blocks SELECT * FROM blocks` is a pure
-- copy — so referencing FK rows continue to point at valid ids
-- throughout the migration.
--
-- The two BEFORE triggers from migration 0005 (the block_type-enum
-- guard) are dropped along with the old table and recreated verbatim
-- against the renamed table so any downstream test that pins the
-- `RAISE(ABORT, 'invalid block_type: must be content, tag, or page')`
-- message keeps working. The 9 live indexes from migrations
-- 0001 / 0012 / 0013 / 0023 / 0024 / 0027 / 0047 are recreated; the
-- dropped indexes `idx_blocks_parent` (replaced in 0024, dropped in
-- 0045) and `idx_blocks_conflict` (dropped in 0058 with the
-- `is_conflict` column) are NOT recreated.
--
-- Audit predicate (the body of the new CHECK):
--   SELECT COUNT(*) FROM blocks
--    WHERE block_type = 'page' AND page_id != id;
--
-- On every database in steady state post-0066 this returns 0 and the
-- INSERT below succeeds. If a write path between 0066 and 0073 landed
-- a page row with `page_id != id`, the bulk-copy INSERT fails with
-- `CHECK constraint failed: page_id_self_for_pages`, sqlx rolls back
-- the migration tx and the original `blocks` table is left untouched
-- — equivalent to a panic, fail-loud-and-safe. Operator's job to
-- repair the row (set `page_id = id` for the offending block, or
-- soft-delete it) and re-run the migration.
--
-- Self-FK ON DELETE semantics: the original 0001 declaration of
-- `parent_id TEXT REFERENCES blocks(id)` and 0066's introduction of
-- `page_id TEXT REFERENCES blocks(id)` both left the ON DELETE rule
-- implicit (SQLite default RESTRICT). This migration preserves that
-- implicit form unchanged — adding explicit CASCADE on the self-FKs
-- is a separate, behaviour-affecting decision (hard-deleting a page
-- would propagate to all child blocks) outside the scope of #111.

-- ---------------------------------------------------------------------
-- Step 3: create the new table with the CHECK constraint, all current
-- columns in the same order as today's `blocks` (so existing sqlx
-- `query_as!`/`FromRow` bindings keyed by column index keep working
-- — notably `BlockRow` in `src-tauri/src/pagination/mod.rs` and the
-- two `SELECT id, block_type, content, parent_id, position,
-- deleted_at, todo_state, priority, due_date, scheduled_date, page_id
-- FROM blocks` sites in `commands/blocks/crud.rs`).
--
-- Column-set evolution: starts from 0001 (id, block_type, content,
-- parent_id, position, deleted_at, archived_at, is_conflict,
-- conflict_source) plus 0007 (`conflict_type`), 0012 (`todo_state`,
-- `priority`, `due_date`), 0013 (`scheduled_date`), 0027 (`page_id`),
-- minus 0018 (`archived_at`), 0058 (`is_conflict`), 0059
-- (`conflict_type`), 0060 (`conflict_source`). Net 11 columns.
--
-- STRICT is added per the migrations/AGENTS.md convention for new
-- `CREATE TABLE` statements. Existing data is already type-clean (every
-- writer goes through sqlx's typed binds), and 0061/0062 promoted the
-- 10 dependent tables to STRICT without issue.
-- ---------------------------------------------------------------------
CREATE TABLE _new_blocks (
    id             TEXT NOT NULL PRIMARY KEY,
    block_type     TEXT NOT NULL DEFAULT 'content',
    content        TEXT,
    parent_id      TEXT REFERENCES blocks(id),
    position       INTEGER,
    deleted_at     TEXT,
    todo_state     TEXT,
    priority       TEXT,
    due_date       TEXT,
    scheduled_date TEXT,
    page_id        TEXT REFERENCES blocks(id),
    CONSTRAINT page_id_self_for_pages CHECK (
        block_type != 'page' OR page_id = id
    )
) STRICT;

-- ---------------------------------------------------------------------
-- Step 4: copy rows. The CHECK fires per-row during the bulk copy; a
-- violation aborts the migration with the original `blocks` intact.
-- ---------------------------------------------------------------------
INSERT INTO _new_blocks
    (id, block_type, content, parent_id, position, deleted_at,
     todo_state, priority, due_date, scheduled_date, page_id)
    SELECT id, block_type, content, parent_id, position, deleted_at,
           todo_state, priority, due_date, scheduled_date, page_id
    FROM blocks;

-- ---------------------------------------------------------------------
-- Step 5 + 6: drop the old table (also drops its indexes and the two
-- BEFORE triggers from 0005), rename the new table into place. FK
-- constraints on referencing tables re-resolve by name at commit time
-- once `blocks` exists again with the same row set.
-- ---------------------------------------------------------------------
DROP TABLE blocks;
ALTER TABLE _new_blocks RENAME TO blocks;

-- ---------------------------------------------------------------------
-- Step 7a: recreate the two block_type-enum BEFORE triggers from
-- migration 0005 verbatim. RAISE message is preserved character-for-
-- character so any test that pins it (e.g. via `.expect_err(...)`
-- matching on the message body) keeps working.
-- ---------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS check_block_type_insert
BEFORE INSERT ON blocks
BEGIN
    SELECT RAISE(ABORT, 'invalid block_type: must be content, tag, or page')
    WHERE NEW.block_type NOT IN ('content', 'tag', 'page');
END;

CREATE TRIGGER IF NOT EXISTS check_block_type_update
BEFORE UPDATE OF block_type ON blocks
BEGIN
    SELECT RAISE(ABORT, 'invalid block_type: must be content, tag, or page')
    WHERE NEW.block_type NOT IN ('content', 'tag', 'page');
END;

-- ---------------------------------------------------------------------
-- Step 7b: recreate every live index. Order and exact definition match
-- the source migrations so `EXPLAIN QUERY PLAN` output stays stable for
-- any test that pins it.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_blocks_type
    ON blocks(block_type, deleted_at);
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
