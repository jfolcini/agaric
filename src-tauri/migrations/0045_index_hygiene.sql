-- PEND-20 A: Index hygiene — drop 4 redundant indexes + replace
-- `idx_block_properties_space` with a covering variant.
--
-- Each drop has been audited against the schema for an existing
-- covering / superset index:
--
-- 1. `idx_block_props_key_num` (migration 0004) — identical columns
--    (`key`, `value_num`) and partial predicate (`WHERE value_num
--    IS NOT NULL`) to `idx_block_properties_key_value_num` from
--    migration 0022. Keep the newer, better-named one.
-- 2. `idx_blocks_parent` (migration 0001) — strict prefix of
--    `idx_blocks_parent_covering` (parent_id, deleted_at, position,
--    id) from migration 0024. Migration 0024 explicitly notes the
--    intent to replace the old index.
-- 3. `idx_page_aliases_page` (migration 0015) — redundant with the
--    table's `PRIMARY KEY (page_id, alias)`, which already indexes
--    `page_id` as the leading column.
-- 4. `idx_agenda_date` (migration 0001) — redundant with
--    `agenda_cache`'s `PRIMARY KEY (date, block_id)`, which already
--    indexes `date` as the leading column.
--
-- The covering index swap turns the 16+ space-filter subqueries
-- (`COALESCE(b.page_id, b.id) IN (SELECT bp.block_id FROM
-- block_properties bp WHERE bp.key = 'space' AND bp.value_ref =
-- ?N)`) from "search index then row-fetch for block_id" into
-- index-only by adding `block_id` as a trailing column.
--
-- Index migrations don't require STRICT (STRICT applies to CREATE
-- TABLE only). No table is created or modified here.

DROP INDEX IF EXISTS idx_block_props_key_num;
DROP INDEX IF EXISTS idx_blocks_parent;
DROP INDEX IF EXISTS idx_page_aliases_page;
DROP INDEX IF EXISTS idx_agenda_date;

DROP INDEX IF EXISTS idx_block_properties_space;
CREATE INDEX IF NOT EXISTS idx_block_properties_space_covering
    ON block_properties(value_ref, block_id)
    WHERE key = 'space';
