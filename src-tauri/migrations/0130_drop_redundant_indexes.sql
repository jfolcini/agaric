-- #6522: drop two indexes no query needs.
--
-- `idx_op_log_block_id (block_id)` (0030, recreated by 0079) is a prefix of
-- `idx_op_log_block_created (block_id, created_at)` (0095), which serves
-- every `block_id` lookup the single-column index did. It cost one more
-- B-tree write per op.
--
-- `idx_loro_doc_state_updated_at` (0052) indexes a table with one row per
-- space, and no query filters or orders on `updated_at`.
--
-- mock-unaffected: the mock has no indexes.

DROP INDEX IF EXISTS idx_op_log_block_id;
DROP INDEX IF EXISTS idx_loro_doc_state_updated_at;
