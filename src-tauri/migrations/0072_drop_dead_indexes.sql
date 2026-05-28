-- PEND-103 (issue #103): drop two indexes that no longer serve any queries.
--
-- `idx_op_log_device_op_type` (migration 0008) was created for diffy-merge
-- divergence detection in sync_protocol.rs. PEND-09 (migrations 0057–0060)
-- retired diffy in favour of Loro, removing every production caller. Only
-- test files now query `WHERE device_id = ? AND op_type = ?`; production
-- code combines `op_type` with `block_id` (served by `idx_op_log_block_id`).
--
-- `idx_block_links_source` (migration 0020) is fully redundant with
-- `block_links.PRIMARY KEY (source_id, target_id)`. The table is STRICT and
-- not WITHOUT-ROWID, so SQLite materialises the PK as a B-tree whose leading
-- column is `source_id` — exactly what this index provides. All
-- `WHERE source_id = ?` callers fall through to the PK autoindex
-- (`sqlite_autoindex_block_links_1`) after the drop. db.rs locks this
-- invariant with an EXPLAIN QUERY PLAN test.
--
-- Both drops reduce write-amplification on the highest-write table
-- (`op_log`) and on the hot `block_links` insert path with no read penalty.

DROP INDEX IF EXISTS idx_op_log_device_op_type;
DROP INDEX IF EXISTS idx_block_links_source;
