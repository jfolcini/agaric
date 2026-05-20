# PEND-56b — Pages view materialisation + SortKeyset extraction

> Follow-up to PEND-56 Phase 1 (`list_pages_with_metadata` IPC). Round 2
> performance review measured the scaling cliff for `MostLinked` /
> `MostContent` sorts at **~20k pages, not the originally-predicted
> 100k**. This plan addresses the cliff before users at the size hit it,
> and bundles the deferred Round 1 maintainability work that becomes
> easier to do at the same time.

## TL;DR

- **PROBLEM:** `MostLinked` first-page latency: **95 ms @ 10k pages,
  335 ms @ 20k pages.** Super-linear because each row aggregates
  `block_links` via a correlated subquery; SQLite re-runs the aggregate
  for every page in the space before LIMIT.
- **FIX:** Materialise `inbound_link_count` and `child_block_count`
  into `pages_cache`. Maintained by the materializer on every block /
  link insert/delete (O(1) per op). The aggregate sort becomes
  `SELECT ... ORDER BY pages_cache.inbound_link_count DESC LIMIT 50` —
  index-served, no per-row work.
- **BUNDLE:** Extract a `SortKeyset` descriptor (deferred Round 1
  maintainability MEDIUM) at the same time so the SQL fragment for
  each metadata-derived sort lives in one place and the materialised
  vs computed swap is a one-line change per mode.

## Round 2 measurements (reproduce these before claiming a regression)

Bench setup: sqlite 3.50.6, /tmp scratch DB, schema from migrations
0001/0020/0027/0030/0034/0066. Seed: 10k or 20k pages (90% live in
TestSpace, 10% soft-deleted), 50k or 100k links with ~10% from
soft-deleted sources, op_log rows for every page. ANALYZE before
measuring. 3× warm; numbers are warm steady-state.

| Sort | 10k pages | 20k pages | Comment |
|---|---|---|---|
| Alphabetical | 5 ms | ~10 ms | Index-served (idx_blocks_page_id + LIMIT) |
| RecentlyModified | 15 ms | ~30 ms | 1 correlated subquery, COALESCE'd cleanly |
| MostContent | 8 ms | ~20 ms | One non-aggregating subquery |
| **MostLinked (post-Round 1)** | **95–105 ms** | **300–335 ms** | DISTINCT + JOIN — super-linear |
| MostLinked DISTINCT no-src-JOIN | 64 ms @ 10k | n/a | Drop src.deleted_at filter (already applied) |
| MostLinked pre-Round 1 | 11 ms @ 10k | 24 ms @ 20k | Pre-DISTINCT — incorrect counts |

### Why the cliff is sharp

- The MostLinked subquery runs the `block_links → blocks` JOIN +
  `COUNT(DISTINCT source_id)` aggregation **for every page** in the
  space, then sorts on the aggregate, then applies LIMIT 50.
- Cursor pagination doesn't help — the keyset filter still requires
  evaluating the aggregate for every candidate row.
- `EXPLAIN QUERY PLAN` confirms: `USE TEMP B-TREE FOR ORDER BY` — no
  covering index for the aggregate. Even on a perfectly-tuned schema
  there's no plan that avoids the full-table aggregate.

## Proposed fix

### Materialise into `pages_cache`

`pages_cache` (introduced by migration 0001 and extended several times)
already keys on `page_id` and gets touched by the materializer on every
page lifecycle event. Add two columns:

```sql
-- migration 0069_pages_cache_inbound_link_count.sql
ALTER TABLE pages_cache ADD COLUMN inbound_link_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages_cache ADD COLUMN child_block_count INTEGER NOT NULL DEFAULT 0;

-- Backfill from the existing data.
UPDATE pages_cache SET inbound_link_count = (
    SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl
        JOIN blocks descendant ON bl.target_id = descendant.id
        WHERE descendant.page_id = pages_cache.page_id
          AND descendant.deleted_at IS NULL
);
UPDATE pages_cache SET child_block_count = (
    SELECT COUNT(*) FROM blocks descendant
        WHERE descendant.page_id = pages_cache.page_id
          AND descendant.deleted_at IS NULL
          AND descendant.id != pages_cache.page_id
);
```

Maintenance is the materializer's responsibility on these op kinds:

- `CreateBlock` (page or non-page): `child_block_count` +=1 for owner.
- `DeleteBlock` (soft-delete): `child_block_count` −=1.
- `RestoreBlock`: `child_block_count` +=1.
- `EditBlock`: re-parse content for `[[ULID]]` tokens, diff against
  prior content's tokens, increment / decrement `inbound_link_count`
  on the target page (or pages) and per the DISTINCT semantics.

### Extract `SortKeyset`

```rust
// src-tauri/src/commands/pages_sort_keyset.rs (or inline in pages.rs)
struct SortKeyset {
    sql_select_alias: &'static str,  // e.g., "inbound_link_count"
    sql_keyset_predicate: fn(&Cursor) -> (String, Vec<Bind>),
    sql_order_by: &'static str,
}

fn keyset_for(sort: PageSort) -> SortKeyset { ... }
```

Each `match filter.sort` arm in `list_pages_with_metadata_inner` becomes
a one-line lookup, and the materialised-vs-computed swap is a single
constant change per mode.

## Cost / Impact / Risk

- **Engineering cost:** M (~6-10 h). Migration (~1 h), materializer
  maintenance hooks (~2-3 h, plus tests), SortKeyset extraction (~2 h),
  refactor of `list_pages_with_metadata_inner` to use materialised
  columns (~1-2 h), regression tests (~1-2 h).
- **Impact:** MostLinked / MostContent first-page latency drops from
  335 ms → ~5 ms at 20k pages (index-served). Scales to 100k+ pages
  trivially. Unblocks PEND-58 grooming facets (`orphan:` /
  `has-no-inbound-links:`) which would have the same scaling problem.
- **Risk:** Materializer correctness — the count maintenance has to
  exactly mirror the SELECT-derived counts. Mitigation: backfill query
  is the same shape as the live SELECT; comprehensive integration
  tests that assert `materialised == computed` on a 1000-page fixture
  with every block-lifecycle path exercised.

## Acceptance criteria

- New migration 0069 adds the two columns + backfill, both idempotent.
- Materializer maintains both columns on `CreateBlock` /
  `DeleteBlock` / `RestoreBlock` / `EditBlock`.
- Integration test: 1000-page fixture, exercise every materializer
  path, assert `pages_cache.inbound_link_count` matches
  `SELECT COUNT(DISTINCT ...)` for every page.
- `list_pages_with_metadata_inner` reads the materialised column for
  `MostLinked` / `MostContent` SELECT and keyset.
- Bench: 20k-pages MostLinked latency under 50 ms (vs current 335 ms).
- `SortKeyset` extraction lands in the same PR; cyclomatic complexity
  of `list_pages_with_metadata_inner` drops (was 5 match arms × 2 each).

## Related

- PEND-56 (parent) — `list_pages_with_metadata` IPC + cursor pagination.
- PEND-58 (downstream) — compound filters; `orphan:` / `stub:` /
  `has-no-inbound-links:` facets have the same cliff and would benefit
  from the same materialisation.
- Round 2 performance review (commit `abe8db17`'s message references it).
