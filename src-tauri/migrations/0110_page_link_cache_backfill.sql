-- #3839: one-shot backfill of `page_link_cache` for every vault upgrading
-- past migration 0065 (which created the table with NO backfill).
--
-- mock-unaffected: `page_link_cache` is a derived cache the JS Tauri mock
-- does not model (it recomputes page links from its in-memory blocks/links
-- stores); this migration adds no column and changes no table the mock reads.
--
-- Why a migration and not the read path. Until now the ONLY thing that ever
-- populated this rollup from pre-existing `block_links` rows was the lazy
-- rebuild in `list_page_links_inner_split`, and that rebuild is gated on the
-- table being ENTIRELY empty (`SELECT NOT EXISTS (SELECT 1 FROM
-- page_link_cache)`). "Is the table empty?" is a proxy for "has this vault
-- ever been backfilled?", and it stops being a valid proxy the moment any
-- incremental maintenance succeeds: the first create/edit that writes a
-- single cache row disarms the backfill permanently, stranding every
-- pre-existing edge out of the graph until a delete/restore/purge/
-- cross-page-move/snapshot happens to fire a full `RebuildPageLinkCache`.
-- Enumerated (#3839): migration 0065 has no backfill, `src/db/recovery/`
-- never touches the table, and `rebuild_all_caches` is `#[cfg(test)]` — so
-- there was no other backfill anywhere. Populating at upgrade time demotes
-- the lazy heal to a redundancy behind this migration.
--
-- The rollup below is the SQL of `agaric_store::cache::rebuild_page_link_cache`
-- (`agaric-store/src/cache/page_links.rs`), transcribed verbatim so the
-- upgrade-time state is byte-identical to what a full rebuild produces:
--   * source rolls up via `COALESCE(page_id, parent_id, source_id)` (SQL/C9,
--     #345 — `page_id` is the nearest page ancestor, `parent_id` the legacy
--     single-step fallback, `source_id` covers top-level tags),
--   * `WHERE sb.deleted_at IS NULL` so a soft-deleted source block does not
--     inflate `edge_count`,
--   * the #2070 denormalised flags: `src_deleted` from the rolled-up source
--     PAGE (a missing/purged page maps to deleted, mirroring the legacy
--     read's inner join), `tgt_deleted` / `tgt_is_page` from the target block
--     (one block per group, so MAX/MIN are identity there).
--
-- Idempotent by construction: the DELETE makes this a recompute rather than a
-- merge, so a vault whose cache was already (partially) filled by the lazy
-- heal converges on the same rows instead of colliding on the
-- `(source_page_id, target_page_id)` primary key. A fresh vault has empty
-- `block_links`, so both statements are no-ops.
--
-- `INSERT OR IGNORE`, not a plain `INSERT`: an abort inside a migration is a
-- BOOT FAILURE, not a logged background error. `GROUP BY 1, 2` over
-- BINARY-collated TEXT on a STRICT table makes a
-- `(source_page_id, target_page_id)` PK collision impossible in practice, so
-- this is defensive only — but `rebuild_page_link_cache_impl` (the function
-- this SQL transcribes) uses `INSERT OR IGNORE`, and matching it keeps the
-- transcription byte-identical in FAILURE behaviour and not just in the rows
-- produced.
--
-- FOREIGN KEY safety — the `EXISTS` guard (#3894). Both cache columns are
-- `NOT NULL REFERENCES blocks(id) ON DELETE CASCADE` (0065), and foreign keys
-- are ON for every connection the app opens, migrations included
-- (`agaric-store/src/db/mod.rs`, `base_connect_options`'s
-- `pragma("foreign_keys", "ON")`). `INSERT OR IGNORE` does NOT cover this:
-- per the SQLite docs the ON CONFLICT algorithm does not apply to FOREIGN KEY
-- constraints, so an FK violation raises regardless of the conflict clause —
-- and raising HERE is an unrecoverable boot failure on a user's vault.
--
--   * TARGET side: safe with no extra predicate. `target_page_id` is
--     `bl.target_id`, and `JOIN blocks tb ON tb.id = bl.target_id` is an INNER
--     join, so a `block_links` row pointing at a purged target produces no
--     output row at all.
--   * SOURCE side: NOT safe without the guard, because `source_page_id` is not
--     a joined column but the derived key `COALESCE(sb.page_id, sb.parent_id,
--     bl.source_id)`. `sb` joining fine says nothing about the KEY: a live
--     source block carrying a dangling `page_id` (or `parent_id`) rolls up to
--     an id that is not in `blocks`, and the INSERT aborts the migration.
--
-- That dangling state is not hypothetical. Migrations 0073 and 0085 both NULL
-- out historical dangling `parent_id` / `page_id` before their table rebuilds,
-- which is direct evidence that vaults in the wild carry it — any historical
-- `foreign_keys = OFF` window is enough to produce it. So the head-state FK
-- reasoning above must not be conditional on a vault's data being clean.
--
-- The guard makes it unconditional: a group whose rollup key names no `blocks`
-- row is SKIPPED instead of aborting the upgrade. It cannot distort any
-- surviving row — the key is the first GROUP BY term, so `EXISTS` is constant
-- across a group and the filter can only drop whole groups, never a subset of
-- one group's `COUNT(*)`. On a clean vault it drops nothing, so the rows
-- produced are unchanged. The `MAX(CASE WHEN sp.id IS NULL THEN 1 …)` arm is
-- consequently unreachable from this statement; it is kept verbatim because
-- `rebuild_page_link_cache_impl` carries it (that function got the same guard
-- in #3894, so this file remains an exact transcription).
--
-- Expected runtime: <1s at 100K `block_links` rows, matching sibling data
-- migrations (e.g. 0066). Basis — the query shape, not a guess: one sequential
-- scan of `block_links` (the only unbounded relation here; a vault's link count
-- is bounded by its `[[…]]`/`((…))` token count, far below its block count),
-- three PK-indexed lookups into `blocks` per row (`sb`/`tb` inner joins and the
-- `sp` LEFT JOIN all probe `blocks.id`, the INTEGER-rowid-aliased PK), and one
-- sort/aggregate over the scanned rows for `GROUP BY 1, 2`. That is
-- O(E log E) with an index probe per edge and no correlated subquery, over the
-- same relation `rebuild_page_link_cache` already traverses on every
-- delete/restore/purge in the running app.
--
-- No op_log writes (migrations must never append synthetic ops) — this only
-- rebuilds a derived cache.

DELETE FROM page_link_cache;

INSERT OR IGNORE INTO page_link_cache
    (source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, tgt_is_page)
SELECT
    COALESCE(sb.page_id, sb.parent_id, bl.source_id),
    bl.target_id,
    COUNT(*),
    MAX(CASE WHEN sp.id IS NULL THEN 1 ELSE (sp.deleted_at IS NOT NULL) END),
    MAX(tb.deleted_at IS NOT NULL),
    MIN(tb.block_type = 'page')
FROM block_links bl
JOIN blocks sb ON sb.id = bl.source_id
JOIN blocks tb ON tb.id = bl.target_id
LEFT JOIN blocks sp ON sp.id = COALESCE(sb.page_id, sb.parent_id, bl.source_id)
WHERE sb.deleted_at IS NULL
  AND EXISTS (
      SELECT 1 FROM blocks fk
      WHERE fk.id = COALESCE(sb.page_id, sb.parent_id, bl.source_id)
  )
GROUP BY 1, 2;
