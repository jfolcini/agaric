-- M-93: add ON DELETE CASCADE FK from block_drafts.block_id to blocks(id).
--
-- Per REVIEW-LATER.md M-93: the original `block_drafts` schema (0001_initial.sql)
-- declared no foreign key to `blocks(id)`, even though AGENTS.md invariant #7
-- enforces `PRAGMA foreign_keys = ON` on every connection. As a result, drafts
-- could outlive their parent blocks (e.g., after a hard-delete or peer-purge),
-- and crash recovery synthesised no-op edit_block ops for those orphans —
-- inflating compaction and polluting forensic traces.
--
-- SQLite cannot `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` after creation,
-- so we follow the recreate-table-with-FK pattern. Precedent:
-- 0019_add_ref_value_type.sql recreates `property_definitions` to widen its
-- CHECK constraint.
--
-- Pre-cleanup: existing user DBs may already have orphan drafts (drafts whose
-- block_id no longer exists in `blocks`, produced before this migration).
-- We DELETE them here, before the table swap, so the INSERT into the new
-- (FK-constrained) table cannot fail with FOREIGN KEY constraint violations.
--
-- Once this migration runs, AGENTS.md invariant #7 (`PRAGMA foreign_keys = ON`
-- on every connection in both pools — see `init_pools` / `init_pool` in
-- src/db.rs) immediately enforces the new FK. Future hard-deletes of a
-- `blocks` row cascade-delete its `block_drafts` row in the same statement.
-- Soft-deletes do NOT cascade — the FK references the `blocks` row, not its
-- `deleted_at` column — so `flush_draft_inner`'s soft-deleted-target guard
-- (commands/drafts.rs) and `sweep_orphan_drafts` (draft.rs) remain load-
-- bearing for that case.

DELETE FROM block_drafts
WHERE block_id NOT IN (SELECT id FROM blocks);

CREATE TABLE block_drafts_new (
    block_id TEXT PRIMARY KEY NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO block_drafts_new (block_id, content, updated_at)
    SELECT block_id, content, updated_at FROM block_drafts;

DROP TABLE block_drafts;

ALTER TABLE block_drafts_new RENAME TO block_drafts;
