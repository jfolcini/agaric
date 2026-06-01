-- Issue #109 Phase 2 (cluster): migrate `blocks.deleted_at` from TEXT
-- (RFC 3339) to INTEGER milliseconds-since-UNIX-epoch (UTC), nullable
-- (NULL = live). Maintainer decision 2026-05-29: hard cutover. This flips
-- `blocks.deleted_at` in lockstep with the snapshot format (`BlockSnapshot`)
-- and the FE IPC types.
--
-- `blocks` is the FK parent for ~14 referencing tables, so this is the
-- canonical 12-step rebuild (precedent 0061/0062/0073). FK constraints on
-- referencing tables re-resolve by name at the migration tx's commit; no DML
-- runs during the DROP→RENAME window, and the bulk copy preserves every row,
-- so referencing FK rows stay valid throughout. The page_id_self_for_pages
-- CHECK (0073), the two block_type BEFORE triggers (0005), and all 9 live
-- indexes (0001/0012/0013/0023/0024/0027/0047/0073) are recreated verbatim;
-- only `deleted_at`'s type changes (TEXT → INTEGER, nullable with a
-- `col IS NULL OR col >= 0` CHECK). Soft-delete writes/restore continue to
-- key on the cascade timestamp, now an i64 (`crate::db::now_ms()`).
--
-- Backfill: NULL stays NULL (live rows); a non-null RFC 3339 string converts
-- via the ms-precise julianday formula.

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
    )
) STRICT;

INSERT INTO _new_blocks
    (id, block_type, content, parent_id, position, deleted_at,
     todo_state, priority, due_date, scheduled_date, page_id)
    SELECT id, block_type, content, parent_id, position,
           CASE WHEN deleted_at IS NULL THEN NULL
                ELSE CAST(ROUND((julianday(deleted_at) - 2440587.5) * 86400000.0) AS INTEGER)
           END,
           todo_state, priority, due_date, scheduled_date, page_id
    FROM blocks;

DROP TABLE blocks;
ALTER TABLE _new_blocks RENAME TO blocks;

-- Recreate the two block_type-enum BEFORE triggers (0005) verbatim.
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

-- Recreate every live index (order/definition matches the source migrations).
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
