-- Issue #533: promote space membership from a `block_properties` row
-- (`key = 'space'`, `value_ref = <space_block_id>`) to a native, indexed
-- `space_id` column on `blocks`.
--
-- Background: space membership was bolted onto the property system rather
-- than the schema. Every paginated read path therefore carries a
-- correlated sub-select against `block_properties`:
--
--   (?N IS NULL OR b.page_id IN (
--       SELECT bp.block_id FROM block_properties bp
--       WHERE bp.key = 'space' AND bp.value_ref = ?N))
--
-- The covering index `idx_block_properties_space_covering` (0045) makes
-- each lookup index-only, but no single index can satisfy a
-- space-filtered + type-filtered query in one pass, and every new list
-- feature inherits the join. A first-class column collapses the filter to
-- `b.space_id = ?N` and lets one composite index cover space + type.
--
-- Design: `space_id` is a *derived denormalization* maintained exactly
-- alongside the existing `page_id` denormalization (space is a page-level
-- concept — a block belongs to the space of its owning page). The
-- `block_properties(key = 'space')` rows remain the source of truth and
-- continue to drive the property-system invariants (cross-space ref
-- rejection, delete-empty-space checks); `space_id` is a query cache that
-- a rebuild can always reconstruct from them. Removing the property rows
-- and the parallel routing is a deliberately separate later phase.
--
-- Mechanics:
--   * ADD COLUMN is valid without a table rebuild — the column is nullable
--     with an implicit NULL default, which SQLite permits even with a
--     REFERENCES clause (a NOT NULL / non-NULL-default FK column would
--     require the 12-step rebuild). `foreign_keys = ON` from init_pool
--     re-validates nothing here because every backfilled value is an
--     existing `blocks.id` (it came from a `value_ref` that already
--     REFERENCES blocks(id)).
--   * Backfill mirrors the canonical read filter verbatim: a block's space
--     is the `space` property attached to its `page_id` (a page's own
--     `page_id` equals its id per the `page_id_self_for_pages` CHECK, so
--     pages pick up their own space too). Orphan blocks with NULL `page_id`
--     get NULL `space_id` — exactly the rows the `IN (...)` filter excluded.

ALTER TABLE blocks ADD COLUMN space_id TEXT REFERENCES blocks(id);

UPDATE blocks SET space_id = (
    SELECT bp.value_ref FROM block_properties bp
    WHERE bp.key = 'space'
      AND bp.block_id = blocks.page_id
);

-- Composite covering index for the common space-filtered + type-filtered
-- list query (e.g. "pages in space S", "alive content in space S"),
-- mirroring the shape of idx_blocks_type (block_type, deleted_at, id).
CREATE INDEX IF NOT EXISTS idx_blocks_space_type
    ON blocks(space_id, block_type, deleted_at, id);
