-- PERF-26: add extracted block_id column + index for O(log N) lookups
-- during draft recovery instead of linear JSON scans.
--
-- Rationale: draft_recovery.rs previously used json_extract(payload, '$.block_id')
-- with a LIKE pre-filter to narrow candidates. That still forced a full-table
-- scan of op_log at scale. By extracting the block_id into a dedicated column
-- populated on insert (see op_log.rs `extract_block_id`), we can index it and
-- make block-scoped op_log lookups O(log N).
--
-- This is additive: the op log invariant (strictly append-only) is preserved.
-- No op semantics change — we only add a redundant, derivable index column.

ALTER TABLE op_log ADD COLUMN block_id TEXT;

-- Backfill from existing rows. One-time cost at migration time; future
-- inserts populate block_id directly via the Rust typed OpPayload enum.
-- Every OpPayload variant has a block_id field, so json_extract always
-- yields a value for existing rows.
UPDATE op_log
SET block_id = json_extract(payload, '$.block_id')
WHERE block_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_op_log_block_id ON op_log(block_id);
