## Session 976 — gate the O(pages) pages_cache count recompute to the RESET path (#417) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#417` |
| **Builds on** | `#432`/session-973 (local-path scoped count maintenance landed first) |
| **Tests added** | +2 backend integration (local move both-page counts; local delete inbound decrement) + 1 dispatch-pin + snapshot count assertion |
| **Files touched** | 12 |
| **Schema / wire-format** | none (no migration, no new op type, no `.sqlx` change) |

**Summary:** `apply_sort_merge_rebuild` ended with an **unconditional, WHERE-less**
full-table UPDATE recomputing both `pages_cache` count columns via correlated
`COUNT(DISTINCT …)` subqueries — `O(pages)` temp-B-tree subqueries on *every*
`RebuildPagesCache` task, which dispatch enqueues on every per-op page mutation
(create / edit-title / delete / restore / purge / move). Session-973 had already
made the **scoped** per-op recompute cover both the sync `ApplyOp` path and the
local *create* path, so the full-table pass was pure redundant work outside the
one scenario its own comment cited: a snapshot/sync **RESET** that wipes
`pages_cache` and re-inserts rows with `DEFAULT 0` counts.

This session removes the full-table pass from the per-op rebuild and confines it
to the RESET path, exactly as the issue recommended (separate task, not a bool
param):

1. **Split `apply_sort_merge_rebuild`** → titles/orphans only. The `#432`-guarded
   count UPDATE moved verbatim into a new `recompute_all_pages_cache_counts`
   (still the `WHERE … != (<subq>)` guarded form, so `rows_affected()` = pages
   whose counts actually drifted; `updated_at` untouched).
2. **New `MaterializeTask::RebuildPagesCacheCounts`** + `rebuild_pages_cache_counts`
   background entry point (own write tx, `changed == 0 → rollback`). Mirrored in
   `RetryKind` (label / parse / global-dedup / `to_task`).
3. **Enqueued ONLY by `apply_snapshot`**, separately at the tail *after* the
   `CACHE_TABLES` `RebuildPagesCache` re-inserts the page rows. Background consumer
   processes in strict enqueue order and the two are distinct dedup discriminants,
   so the count pass always observes the freshly-rebuilt rows. No per-op fan-out
   path enqueues it (pinned by a new dispatch test).
4. **Local delete / restore / purge / move** now do the **scoped** in-tx recompute
   themselves (they previously leaned on the full-table pass):
   - delete/restore: `affected_pages_for_subtree` = subtree-owning pages ∪ outbound
     link-target pages (depth-100 CTE, indexed `block_links` join), recomputed after
     the soft-delete/restore UPDATE.
   - purge: captures outbound link targets *before* the `block_links` DELETE
     (excluding the subtree's own pages, whose `pages_cache` rows are purged).
   - move: `{ old owning page } ∪ { new owning page } ∪ { outbound targets }`, old
     page captured before `page_id` reprojection.
   All feed the same idempotent `recompute_pages_cache_counts_for_pages` with a
   *superset* candidate set — timing only affects which rows are candidates, not the
   recomputed values.

**Why no full refactor / no measurement gate here (unlike #416/#424):** #417's own
adversarial note already measured the cost (~11ms @ 10k pages, best-case zero links,
~100× the scoped path) and the remedy is a pure redundancy removal with an exact
parity oracle, so it ships directly rather than behind a new bench.

**Files touched:**
- `cache/pages.rs` — split rebuild; new `recompute_all_pages_cache_counts` + `rebuild_pages_cache_counts`.
- `cache/mod.rs` — re-exports; test-only `rebuild_all_caches` recomputes counts after the title rebuild.
- `materializer/{mod,dispatch,handlers,retry_queue}.rs` — new task variant, handler, retry mirror, dispatch label.
- `snapshot/restore.rs` — enqueue `RebuildPagesCacheCounts` at the RESET tail.
- `commands/blocks/crud.rs` — scoped recompute on delete/restore/purge + `affected_pages_for_subtree`.
- `commands/blocks/move_ops.rs` — scoped recompute on move.
- `cache/tests.rs`, `command_integration_tests/pages_cache_counts.rs`, `snapshot/tests.rs`, `materializer/dispatch.rs` — tests.

**Verification:**
- `rebuild_pages_cache_recomputes_counts_c2` parity test (now `rebuild_pages_cache` + `rebuild_pages_cache_counts`) — pass.
- New `local_move_updates_both_pages_child_counts`, `local_delete_of_linking_block_decrements_target_inbound` (link registered via the edit path, matching the harness), `rebuild_pages_cache_counts_persists_when_titles_unchanged` — pass.
- `no_per_op_invalidation_enqueues_rebuild_pages_cache_counts` pins the gate (no op type, with/without block hint, enqueues the RESET-only task).
- `apply_snapshot_rebuilds_caches` asserts counts correct after the full fan-out; `apply_snapshot_uses_awaiting_enqueue_background` bumped 8→9 bg tasks.
- `cargo nextest run cache:: materializer:: snapshot::tests pages_cache command_integration_tests::blocks` — 479 passed. `cargo clippy --tests` clean on changed files (removed a stray `concat!`, switched scoped-recompute call sites to `&mut tx` auto-deref).

**Commit plan:** single commit; rebased on `main` (after #444/#445 merged); PR against `main`.
