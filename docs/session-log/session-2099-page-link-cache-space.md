# Session 2099 — Graph: keep each page link's shared space on `page_link_cache`

#5426 item 4 follow-up, a migration the maintainer approved on the issue. The
space-scoped graph read (`list_page_links`) checked both ends of every cached
edge against the space's live pages. The problem-tier probe measured it at
424–478 ms against a 200 ms budget at 100K.

Migration 0122 adds `page_link_cache.space_id`: the space both pages share, or
NULL for an edge between spaces, an edge with a space-less end, or an edge whose
target is not a page. It depends only on the two pages' `blocks.space_id`. Every
path that changes a page's space queues `RebuildPageLinkCache`: the `space` op's
dispatch arm is new, and sync, restore and space purge already rebuilt. Every
writer computes the same expression: the incremental reindex, both rebuilds
(now in 7-column chunks) and the reconciliation oracle, which folds it
independently. A covering partial index on `(space_id, edge_count DESC, …)`
makes fetch and count a range read. `idx_page_link_cache_live`, whose only
reader went with #5415, is dropped. Between a space change committing and its
background rebuild, a moved page's edges show in its old space, the same
bounded staleness the 0096 flags already have.

The old read and the #5547 read stay as `#[cfg(test)]` oracles. Tests:
- the 0122 backfill, including the dropped index;
- a parity test of fetch and count against both oracles;
- an EXPLAIN test pinning `USING COVERING INDEX idx_page_link_cache_space`;
- writer agreement across the reindex and both rebuilds;
- the oracle catching a stale `space_id` in both directions;
- an end-to-end `move_blocks_to_space` test.

Test fixtures that cached links before stamping spaces now stamp first, as a
real vault would. The 3894 dangling-key test seeded a vault at 0110 and then ran
today's reindex, so it now migrates to head first.

Falsified on copies in the lane:
- dropping the dispatch arm's rebuild turned the move, 5275 and placement tests
  red;
- unscoping the fetch turned the parity and EXPLAIN tests red, and five
  existing `list_page_links` space tests.

The review also caught a plan comment that overclaimed (with planner statistics the count can scan a one-space cache, still
far under the old read), and a stale "never holds cross-space rows" comment in
`block_links.rs`.

Suites run:
- `just gen-sqlx` against a migrated scratch database, after each merge of
  `main`;
- nextest on the graph, page-link, migration, `db::tests`, cache, materializer,
  reconciliation and conformance subsets: 942 passed;
- clippy and `cargo doc` with the CI lint flags.
