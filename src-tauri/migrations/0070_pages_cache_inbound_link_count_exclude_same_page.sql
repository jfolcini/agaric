-- PEND-58d (D2) — re-backfill pages_cache.inbound_link_count without
-- same-page/self/deleted-source links.
--
-- (a) Defect: the migration 0069 backfill of `inbound_link_count` used the
--     pre-PEND-58 IPC shape, which only joined `block_links` to the target
--     descendants and never inspected the *source* block. As a result it
--     counted same-page edges (a block on page P linking to another block
--     on the same page P), self-references, and links whose source had been
--     soft-deleted or has no resolvable `page_id` (orphan). Those phantom
--     edges corrupt every consumer of the materialised column: the `Orphan`
--     / `HasNoInboundLinks` filters (`COALESCE(pc.inbound_link_count,0) = 0`
--     never matched a page whose only inbound edge was same-page), the
--     `MostLinked` sort, and the `↗N` inbound-link badge.
--
-- (b) Fix: re-backfill `inbound_link_count` with the corrected shape that
--     matches `recompute_pages_cache_counts_for_pages`
--     (`src-tauri/src/materializer/handlers.rs`) and the canonical backlink
--     count in `backlink/grouped.rs::eval_backlink_query_grouped`. The new
--     shape additionally JOINs `blocks AS src ON src.id = bl.source_id` and
--     excludes same-page/self sources (`src.page_id != pages_cache.page_id`)
--     plus deleted/orphan sources (`src.deleted_at IS NULL`,
--     `src.page_id IS NOT NULL`). This is the source of truth the live IPC
--     reads via `pc.inbound_link_count`.
--
-- (c) `child_block_count` is correct and is intentionally left untouched by
--     this migration.
--
-- Idempotency: the single UPDATE below is a correlated re-computation from
-- the raw `blocks` + `block_links` tables, so it converges every row to the
-- corrected value regardless of the prior (over-counted) state. sqlx applies
-- each migration once in a transaction recorded in `_sqlx_migrations`; once
-- this file's checksum is logged it will not re-run. Even if it did, the
-- recompute is deterministic and idempotent.

UPDATE pages_cache
SET inbound_link_count = (
    SELECT COUNT(DISTINCT bl.source_id)
    FROM block_links AS bl
    INNER JOIN blocks AS descendant
        ON bl.target_id = descendant.id
    INNER JOIN blocks AS src
        ON src.id = bl.source_id
    WHERE descendant.page_id = pages_cache.page_id
        AND descendant.deleted_at IS NULL
        AND src.deleted_at IS NULL
        AND src.page_id IS NOT NULL
        AND src.page_id != pages_cache.page_id
);
