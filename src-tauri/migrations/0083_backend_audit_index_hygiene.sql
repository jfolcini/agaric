-- Backend-audit index hygiene + keyset-ordering support.
--
-- From the 2026-06-05 SQL backend audit (issues #411, #413, #415, #425, #431).
-- Every change below was verified with EXPLAIN QUERY PLAN against the migrated
-- schema: each one removes a `SCAN`/`USE TEMP B-TREE FOR ORDER BY` from a hot
-- read or boot path and replaces it with an index `SEARCH`.
--
-- Index migrations don't require STRICT (STRICT applies to CREATE TABLE, not
-- CREATE INDEX) — cf. 0045_index_hygiene.sql / 0072_drop_dead_indexes.sql.

-- #411 — boot op-log replay walk.
-- op_log PRIMARY KEY is (device_id, seq); seq is the *trailing* column, so the
-- planner cannot serve `WHERE seq > ? ORDER BY seq ASC, device_id ASC` from the
-- PK and falls back to a full SCAN + temp B-tree sort on every lagging boot
-- (measured O(N^2) across the chunked walk). A (seq, device_id) index serves
-- both the range filter and the full ordering, and is covering for the
-- `SELECT COUNT(*) WHERE seq > ?` pre-count.
CREATE INDEX IF NOT EXISTS idx_op_log_seq ON op_log(seq, device_id);

-- #413 — value_ref cascade-delete paths.
-- The only value_ref-touching index is the PARTIAL idx_block_properties_space_covering
-- (... WHERE key = 'space'), unusable for the unqualified value_ref deletes in
-- purge-subtree / empty-trash and for the `value_ref REFERENCES blocks(id)
-- ON DELETE CASCADE` foreign key, all of which full-SCAN block_properties today.
-- A general partial index on value_ref makes all three index-served.
CREATE INDEX IF NOT EXISTS idx_block_properties_value_ref
    ON block_properties(value_ref) WHERE value_ref IS NOT NULL;

-- #415 — list_backlinks first-page ordering.
-- block_links is reached via idx_block_links_target(target_id); the matched
-- source_ids emerge in rowid order, so `ORDER BY b.id` materialised the whole
-- per-target backlink set into a temp B-tree on every fresh open. A
-- (target_id, source_id) composite lets the index supply the order (the query
-- now ORDER BYs bl.source_id, which equals b.id via the join). The composite is
-- a strict superset of the single-column idx_block_links_target, so drop the
-- latter to avoid redundant write amplification (no query forces it by name).
DROP INDEX IF EXISTS idx_block_links_target;
CREATE INDEX IF NOT EXISTS idx_block_links_target_source
    ON block_links(target_id, source_id);

-- #425 — list_by_tag first-page ordering (same pattern as #415).
-- (tag_id, block_id) lets the index supply `ORDER BY bt.block_id`; superset of
-- the single-column idx_block_tags_tag, so drop the latter.
DROP INDEX IF EXISTS idx_block_tags_tag;
CREATE INDEX IF NOT EXISTS idx_block_tags_tag_block
    ON block_tags(tag_id, block_id);

-- #431 — list_by_type / page-browser keyset.
-- idx_blocks_type(block_type, deleted_at) does not carry id, so the
-- `... ORDER BY id ASC LIMIT n` page-browser walk sorts every matching row into
-- a temp B-tree per fetch. Widening to (block_type, deleted_at, id) makes the
-- ORDER BY index-satisfied (covering search, no sort) while remaining a superset
-- for every existing (block_type, deleted_at)-prefix consumer.
DROP INDEX IF EXISTS idx_blocks_type;
CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(block_type, deleted_at, id);
