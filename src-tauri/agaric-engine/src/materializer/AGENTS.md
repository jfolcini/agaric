# `agaric-engine/src/materializer/` — derived-state maintenance

What a change to derived state (caches, FTS, link graphs, `page_id` / `space_id`) owes.

## Enqueueing a commit's tasks

A path that commits several ops hands them to one `Materializer::dispatch_commit` (`CommandTx::commit_and_dispatch` does), never one `dispatch_background` per op in a loop: the background channel is bounded and its send does not block, so a per-op loop over a batch sheds every task past the capacity, and a shed task waits in `materializer_retry_queue` for the sweeper while its block is missing from search and the agenda.

## Narrowing a rebuild

`invalidations_for_op` (`src-tauri/agaric-engine/src/materializer/dispatch.rs`) maps an op to its rebuild tasks; `FULL_CACHE_REBUILD_TASKS` is the correctness-preserving default.

- Before narrowing or skipping a rebuild (a per-op arm, a `block_type_hint` / `move_same_page` hint, a scoped rebuild), list every source table and predicate the cache reads: A content-block delete still moves `tags_cache.usage_count`; a same-page move can carry a nested page.
- Pin the narrowing with a test asserting the narrowed result equals a full rebuild, and pin the narrowing itself: that equality also holds when the op falls back to the full rebuild, so plant a row no rebuild would write, for a block the op does not touch, and assert the op leaves it.
- An absent hint (`None`) keeps the full set. Sync, replay and boot pass none.

## A new derived table or cache

One PR carries the whole lifecycle, or existing vaults never get the rows:

- a full rebuild task, in `FULL_CACHE_REBUILD_TASKS` and `INBOUND_SYNC_CACHE_REBUILD_TASKS` when those paths can stale it (inbound sync and snapshot restore bypass `invalidations_for_op`);
- a `rebuild_*_from_base` arm in the reconciliation oracle (`src-tauri/src/reconciliation_oracle.rs`), folded in Rust from base tables, sharing no code with the maintenance path;
- a durable retry obligation: a failed rebuild must reach `materializer_retry_queue`, never live only in memory.
- a `Derivation` (`agaric-store/src/derivations.rs`) when its rows are the output of a rule that can change: the full rebuild records the version, boot rebuilds a vault that recorded another, and the golden test fails a rule change without a bump (#6488).

Write a durable obligation (`retry_queue::record_failure`) before retiring the record it replaces, and a repair's marker only after its effect is saved: a crash between the two otherwise loses the only evidence of an op that never applied. Pin the order with a mutation that swaps it.

## Paths that add or remove derived rows

Before writing code that makes one path add or remove derived rows, list every path that must undo or repeat it: undo, redo, move (both directions), restore, the batch variant, inbound apply, and the boot rebuild. Restore and move carry descendants the per-op arm cannot see.

A projection that drops a row because its target has no `blocks` row yet (a ref or tag into a block or space that arrives later in the same import) heals it when the target lands (`project_dropped_refs`, `project_dropped_tags`), on inbound sync and engine-first recovery alike: an import walks spaces in a random order, so whether the target exists yet is chance.
