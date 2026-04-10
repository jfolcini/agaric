-- P-18: Normalize NULL positions to sentinel value so IFNULL() is not needed
-- in queries, enabling a covering index on (parent_id, deleted_at, position, id).

-- Step 1: Backfill NULL positions to sentinel (i64::MAX = 9223372036854775807).
-- Tag blocks and some conflict copies have NULL positions — they should sort
-- after all positioned blocks, which the sentinel achieves.
UPDATE blocks SET position = 9223372036854775807 WHERE position IS NULL;

-- Step 2: Add covering index for list_children query.
-- This replaces idx_blocks_parent(parent_id, deleted_at) for child listing.
CREATE INDEX IF NOT EXISTS idx_blocks_parent_covering
    ON blocks(parent_id, deleted_at, position, id);
