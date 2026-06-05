## Session 986 — correct migration-0069's stale "no temp B-tree" plan claim (#433) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#433` (doc) |
| **Dimension** | performance / doc-accuracy (P3 / verified low) |
| **Files touched** | 1 (doc only) |
| **Schema / wire-format** | none |

**Summary:** migration `0069`'s header claims the `MostLinked`/`MostContent`
first-page sort is a "full scan into a quick-sort top-K heap (no temp B-tree)".
`EXPLAIN QUERY PLAN` proves that false: the sort key
`COALESCE(pc.inbound_link_count, 0)` is an expression over a LEFT JOIN on `b.id`
(not indexable), so the plan is `USE TEMP B-TREE FOR ORDER BY` over the whole
filtered set with the 5 residual per-row subqueries evaluated before the sort —
`O(N)`, not top-K. Migrations are append-only/checksummed and cannot be edited
in place, so the correction is documented where the query actually lives
(`PAGES_METADATA_BASE_SELECT` in `commands/pages.rs`), explicitly naming the
stale `0069` claim.

What `0069` genuinely fixed (the `COUNT(DISTINCT)` over `block_links`, pinned by
`most_linked_query_plan_uses_pages_cache_not_block_links`) is unaffected; the
residual subqueries are cheap index probes and the 20k gate passes < 100 ms, so
severity is low and the temp-B-tree-killing schema promotion stays deferred
(same gate as #424).

**Files touched:** `commands/pages.rs` — `#433` correction block on the
`PAGES_METADATA_BASE_SELECT` doc (doc-only).

**Verification:** `SQLX_OFFLINE=true cargo build` + rustfmt clean (doc-only, no behaviour change).

**Commit plan:** single doc commit; branched off `main`; PR against `main`.
