# Session 2120 — Pages sorts read from an index

#5371 follow-up, the maintainer's "make them work". The sorts #5371 shipped
drove from `blocks` through `idx_blocks_space_type`: the list filters by
space, which `pages_cache` did not carry. So every first page sorted the
whole space with a temp B-tree before the `LIMIT`.

Main's weekly perf gate went red after #5371. In CI run 38748918610, on
main's code, Last opened at 20k pages took a median 615 ms against the
250 ms gate. Created and Alphabetical took 39 and 96 ms. That gate runs only
in the `bench-slo` lane, so PR CI did not catch it.

What changed:
- **Migration 0124.** `pages_cache.space_id` is backfilled from the page
  block. There is one `(space_id, key, page_id)` index per sort, in the
  sort's own direction, plus `idx_page_opens_opened`.
- **Query.** It drives from `pages_cache` and cross-joins the live page
  block, so SQLite cannot reorder away from the index.
- **Keysets.** Each keyset reads bare columns, and a cursor page seeks into
  the index at the cursor's key.
- **Last opened.** It reads two arms: opened pages from `page_opens` in open
  order, then the space's never-opened pages in id order. A cursor in the
  tail reads the tail arm alone.
- **Keeping `space_id` right.** A page's `space` op moves it in the same
  transaction (`cache::sync_pages_cache_space_ids`, also used by the boot
  placement). The page-create INSERT copies it, and the page-row rebuild
  repairs any other path.
- **Restores.** The rebuild drops a trashed page's row. With an inner join,
  a restored page would vanish until the next rebuild, so every restore path
  re-inserts the missing row in its own transaction
  (`cache::insert_missing_pages_cache_rows`). The paths are the projection,
  the three restore commands, and undo.
- **Boot check.** Boot schedules the rebuild when a live page has no row or
  a row in another space. That covers an engine reproject in recovery,
  which writes `blocks.space_id` without the cache. The reconciliation
  oracle reports a row in the wrong space.

The review also found the #469 comment on `recompute_all_pages_cache_counts`
false. It claimed the CTE runs each count once per row, but SQLite 3.46
flattens the CTE: the counts run in the change-guard `WHERE` for every row
and again in the `SET` for a row that changes. The comment is deleted.

Trades, measured and accepted:
- The `COUNT` behind `total_count` runs the same predicate from the new
  driver and costs about 1.6x what it did.
- Count, last-edited and title writes now also maintain the indexes.
- An inbound sync writes `blocks.space_id` through the Pass-A bulk upsert,
  not the `space` arm. A page a peer moved therefore lists in its old space
  until the debounced inbound rebuild fires, about 0.3 to 2 s.
- The last-opened opened arm reads every open on the device, since
  `page_opens` has no space.

Tests:
- `every_sort_reads_an_index_instead_of_sorting_the_space_5371` pins each
  sort's plan.
- The `space_id` parity tests follow a page through its space ops, its
  birth, the rebuild and the boot placement.
- Each restore path has a test that the restored page lists at once.
- The 0124 backfill has a test.
- The boot probe has a test, and so does the oracle report.
- `page_through` is now bounded: a cursor that stops advancing fails the
  test instead of hanging until the runner kills it.

Falsified on copies in the lane, each red on the predicted test:
- both projection arms, the boot placement, the rebuild's mismatch repair
  and the birth column;
- the cross join, a coalesced key, the never-opened tail branch, both
  keyset comparisons and the tie order;
- all five restore sites, the oracle diff, and both boot-probe terms.

What ran:
- The full workspace nextest ran in both partitions before the last two main
  merges.
- At the merged head: the targeted pages, cache, reconciliation and
  backlink set, clippy, rustdoc, `just gen-sqlx`, and the 20k-page perf
  gates on this branch and on main on one box.

The perf gates, debug build, same box:
- Last opened drops from a few hundred ms, failing its gate on main, to
  about the other sorts' cost.
- Most linked and Recently modified gain a little.
- Created and the filtered gate get slower. Created's first-page query was
  already cheap on main, so it gains little from its index and pays the
  slower `COUNT`. The release `bench-slo` first-page probe is the number to
  check before merging.
