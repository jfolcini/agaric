-- PEND-56b — materialise inbound_link_count + child_block_count into pages_cache.
--
-- (a) Motivation: round-2 review measured the `MostLinked` first-page
--     latency cliff at ~20k pages, not the originally-predicted 100k:
--     **95 ms @ 10k pages, 335 ms @ 20k pages**, super-linear because
--     each row aggregates `block_links` via a correlated subquery and
--     SQLite re-runs the aggregate for every page in the space before
--     LIMIT 50. Same shape afflicts `MostContent`. Materialising the
--     two aggregates into `pages_cache` (already keyed on `page_id` and
--     touched by the materializer on every page lifecycle event) turns
--     the sort into `ORDER BY pages_cache.inbound_link_count DESC
--     LIMIT 50` — full table scan + quick sort, sub-50 ms at 20k rows.
--
-- (b) The backfill `UPDATE`s below use the **exact same SQL shape** as
--     the live IPC in `commands::pages::list_pages_with_metadata_inner`
--     (`src-tauri/src/commands/pages.rs:1666`) so the materialised
--     values are byte-identical to the previously-computed values at
--     boot. We backfill from `block_links` directly rather than the
--     `page_link_cache` aggregate (migration 0065) because the latter
--     could have drifted; the IPC SELECT is the source of truth.
--
-- (c) Maintenance hooks belong in `src-tauri/src/materializer/handlers.rs`
--     (around `apply_op` / `apply_op_tx` and the per-op `apply_*_via_loro`
--     / `apply_*_sql_only` family — `apply_create_block_via_loro`,
--     `apply_delete_block_via_loro`, `apply_restore_block_via_loro`,
--     `apply_edit_block_via_loro`, `apply_purge_block_via_loro`).
--     Sibling worktree owns those edits; this migration only adds the
--     columns and the one-shot backfill.
--
-- No indexes added in this migration. The hot read paths sort by
-- `inbound_link_count DESC LIMIT 50` / `child_block_count DESC LIMIT 50`
-- over the full table; SQLite's plan for `ORDER BY col DESC LIMIT 50`
-- on tens of thousands of rows is a full scan into a quick-sort
-- top-K heap (no temp B-tree). That is sub-50 ms at 20k rows — well
-- below the 335 ms cliff this migration closes — and adding a
-- secondary `(inbound_link_count DESC)` index would only shave a few
-- ms off the scan while doubling write amplification on every page
-- lifecycle event. Revisit only if a future workload regresses past
-- the 50 ms budget at 100k+ pages.
--
-- Idempotency: `ALTER TABLE … ADD COLUMN` errors on duplicate columns,
-- and sqlx applies each migration in a transaction recorded in
-- `_sqlx_migrations` — once the file's checksum is logged it will not
-- re-run. The backfill `UPDATE`s therefore execute exactly once per
-- database, immediately after the new columns are added.

ALTER TABLE pages_cache
    ADD COLUMN inbound_link_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE pages_cache
    ADD COLUMN child_block_count INTEGER NOT NULL DEFAULT 0;

-- Backfill `inbound_link_count` — same SQL shape as the live IPC
-- SELECT in `commands::pages::list_pages_with_metadata_inner`
-- (`src-tauri/src/commands/pages.rs:1666`).
UPDATE pages_cache
SET inbound_link_count = (
    SELECT COUNT(DISTINCT bl.source_id)
    FROM block_links AS bl
    INNER JOIN blocks AS descendant
        ON bl.target_id = descendant.id
    WHERE descendant.page_id = pages_cache.page_id
        AND descendant.deleted_at IS NULL
);

-- Backfill `child_block_count` — same SQL shape as the live IPC
-- SELECT in `commands::pages::list_pages_with_metadata_inner`
-- (`src-tauri/src/commands/pages.rs:1671`).
UPDATE pages_cache
SET child_block_count = (
    SELECT COUNT(*)
    FROM blocks AS descendant
    WHERE descendant.page_id = pages_cache.page_id
        AND descendant.deleted_at IS NULL
        AND descendant.id != pages_cache.page_id
);
