-- SQL-review 2026-05-14 §2 H-2: materialise the page-level link roll-up
-- so `list_page_links` no longer pays the documented ~1.3 s/100K cost of
-- the 3-JOIN superlinear `block_links × blocks × block_properties`
-- query. The new `page_link_cache` table holds one row per
-- (source_page, target_page) edge with a precomputed `edge_count`,
-- populated incrementally by the materializer's `ReindexBlockLinks`
-- handler and fully rebuilt by `RebuildPageLinkCache` on
-- delete/restore/purge cascades.
--
-- Schema shape mirrors migration 0025 (`projected_agenda_cache`):
-- STRICT table, FK CASCADE on both columns so a page-block delete
-- cleans up dependent edges without app-level fanout, composite PK that
-- doubles as the canonical `(source, target, edge_count)` covering
-- index for the read path.
--
-- The PK already covers `(source_page_id, target_page_id, edge_count)`
-- in SQLite (the PK is a non-rowid implicit covering index on the table
-- because the table is non-WITHOUT-ROWID — but the per-source filter
-- `WHERE source_page_id = ?` benefits from a separate
-- `idx_page_link_cache_source` for prefix lookups; the read query in
-- `list_page_links_inner` filters by both endpoints in some scopes, so
-- a second `idx_page_link_cache_target` accelerates the symmetric
-- direction).

CREATE TABLE IF NOT EXISTS page_link_cache (
    source_page_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_page_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    edge_count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source_page_id, target_page_id)
) STRICT;

-- Secondary indexes for the read path. The PK is the
-- (source, target, edge_count) covering index by virtue of being on a
-- non-WITHOUT-ROWID STRICT table; the explicit covering index name
-- documents the contract and gives `EXPLAIN QUERY PLAN` a stable
-- handle. The `target`-side index supports reverse lookups (e.g.
-- "which pages link TO this one").
CREATE INDEX IF NOT EXISTS idx_page_link_cache_target
    ON page_link_cache(target_page_id);
