# Session 2044 — Page counts walk the page's links again, not the whole space

The weekly `bench-slo` lane (#3394) was cancelled at its time limit:
`reconcile_all_scale_sweep_4901` ran past nextest's 600 s timeout twice,
where it had passed in 95 s a week earlier.

Cause: #5324 added `src.space_id IS page.space_id` to the inbound-link count
in `recompute_all_pages_cache_counts` and in the per-op
`recompute_pages_cache_counts_for_pages`. On a database without
`sqlite_stat1`, that term is indexable through `idx_blocks_space_type`, and
the planner drives the subquery from it: every block in the space times every
block on the page, quadratic in the vault. The sweep paid it in its untimed
settle step, and every page-count recompute in the app paid it per op. The
same commit gave the single-tag usage refresh (`DESIRED_TAG_USAGE_SQL`) the
same plan, a scan of the space per tag.

Fix: a unary `+` on the column side (`+src.space_id`, `+blk.space_id`) keeps
the term a filter, so the planner walks the page's own links again; the
counts are unchanged. A scratch reproduction measured the count rebuild at
40 pages x 100 blocks at 10.5 s before and 0.01 s after.

Suites run: the cache, tags, recompute and reconciliation nextest subsets
over the workspace (330 passed) and the ignored 100K-block sweep, which now
passes in 110 s debug (`reconcile_all` 37 s, counts rebuild 2.4 s).
`just gen-sqlx` regenerated the two changed query caches in all four
`.sqlx` directories.
