-- P-11: Composite index for priority-based queries that filter on
-- key + value_num.  Covers patterns like:
--   WHERE key = 'priority' AND value_num IS NOT NULL ORDER BY value_num
CREATE INDEX IF NOT EXISTS idx_block_properties_key_value_num
    ON block_properties(key, value_num)
    WHERE value_num IS NOT NULL;
