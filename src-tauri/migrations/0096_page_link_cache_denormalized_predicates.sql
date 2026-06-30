-- #2070: denormalise the residual `blocks`-join predicates into
-- `page_link_cache` so the hot unscoped (`SpaceScope::Global`) read in
-- `list_page_links_inner[_split]` collapses to a single indexed cache
-- scan with ZERO `blocks` joins.
--
-- Premise correction: the issue text blames a "3× blocks join to recover
-- titles", but that title roll-up was already removed by migration 0065
-- (`page_link_cache` carries no titles; the frontend sources titles
-- elsewhere). The REAL remaining cost is the two residual `blocks` joins
-- the read still does purely to enforce `src.deleted_at IS NULL`,
-- `tgt.deleted_at IS NULL`, and `tgt.block_type = 'page'`. At 100K those
-- joins are the bottleneck (~1.3 s, over the 200 ms SLO). Denormalising
-- the three predicates as integer flags lets the read filter them with a
-- partial covering index instead of joining `blocks` twice per call.
--
-- Additive `ALTER TABLE ADD COLUMN` only — migration 0065 stays
-- untouched (append-only history; the STRICT-tables hook only checks
-- `CREATE TABLE`, so `ADD COLUMN` is policy-compliant).

ALTER TABLE page_link_cache ADD COLUMN src_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page_link_cache ADD COLUMN tgt_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page_link_cache ADD COLUMN tgt_is_page INTEGER NOT NULL DEFAULT 1;

-- backfill from current blocks state so steady-state is correct before any rebuild
UPDATE page_link_cache SET
  src_deleted = COALESCE((SELECT (b.deleted_at IS NOT NULL) FROM blocks b WHERE b.id = source_page_id), 1),
  tgt_deleted = COALESCE((SELECT (b.deleted_at IS NOT NULL) FROM blocks b WHERE b.id = target_page_id), 1),
  tgt_is_page = COALESCE((SELECT (b.block_type = 'page') FROM blocks b WHERE b.id = target_page_id), 0);

-- partial covering index for the hot unscoped read (single indexed scan, zero blocks joins)
CREATE INDEX idx_page_link_cache_live ON page_link_cache(source_page_id, target_page_id, edge_count)
  WHERE src_deleted = 0 AND tgt_deleted = 0 AND tgt_is_page = 1;
