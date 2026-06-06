-- Issue #533 Phase 2: make `blocks.space_id` (migration 0086) the SOLE
-- source of truth for space membership and retire the
-- `block_properties(key = 'space', value_ref = <space_block_id>)` rows.
--
-- Phase 1 (0086) added the denormalized `space_id` column and dual-wrote
-- it alongside the property row, switching every paginated read filter to
-- `b.space_id = ?`. Phase 2 (this migration + the accompanying Rust
-- changes) removes the parallel property row entirely: the write paths
-- (`set_property_in_tx`, `project_set_property_to_sql`, the delete paths)
-- now write ONLY the column, and every remaining reader was switched off
-- `block_properties WHERE key = 'space'`.
--
-- Data: `space_id` was backfilled from these exact rows in 0086 and has
-- been dual-maintained since, so deleting them loses nothing — every
-- block's space already lives in `blocks.space_id`. The `space` rows are
-- safe to drop outright.
--
-- The append-only op log still contains `SetProperty(key='space')` /
-- `DeleteProperty(key='space')` ops; they remain valid and replay
-- correctly because their projection now targets the column (see
-- `project_set_property_to_sql` / `project_delete_property_to_sql`).

DELETE FROM block_properties WHERE key = 'space';

-- `idx_block_properties_space_covering` (0045) existed solely to make the
-- old `… WHERE key = 'space' AND value_ref = ?` sub-select index-only.
-- With no `space` rows and no reader of them, it is dead weight — drop it.
-- `idx_block_properties_value_ref` (0083) stays: it serves the general
-- FK-cascade path for every other ref-typed property.
DROP INDEX IF EXISTS idx_block_properties_space_covering;
