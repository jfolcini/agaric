-- PEND-35 Tier 3.2: partial index for the conflict listing query.
-- `list_conflicts` (`pagination/hierarchy.rs`) runs:
--   WHERE is_conflict = 1 AND deleted_at IS NULL ORDER BY id ASC
-- with optional `conflict_type` and `id_min` keyset filters. The
-- partial index covers all rows the query touches and supports ASC
-- ordering on `id` for cursor pagination. Mirrors the shape used by
-- `idx_blocks_deleted` (migration 0001) and `idx_blocks_page_alive`
-- (migration 0023).

CREATE INDEX IF NOT EXISTS idx_blocks_conflict ON blocks(id)
  WHERE is_conflict = 1 AND deleted_at IS NULL;
