# `agaric-engine/src/materializer/` — derived-state maintenance

What a change to derived state (caches, FTS, link graphs, `page_id` / `space_id`) owes.

## Narrowing a rebuild

`invalidations_for_op` (`src-tauri/agaric-engine/src/materializer/dispatch.rs`) maps an op to its rebuild tasks; `FULL_CACHE_REBUILD_TASKS` is the correctness-preserving default.

- Before narrowing or skipping a rebuild (a per-op arm, a `block_type_hint` / `move_same_page` hint, a scoped rebuild), list every source table and predicate the cache reads: A content-block delete still moves `tags_cache.usage_count`; a same-page move can carry a nested page.
- Pin the narrowing with a test asserting the narrowed result equals a full rebuild.
- An absent hint (`None`) keeps the full set. Sync, replay and boot pass none.

## A new derived table or cache

One PR carries the whole lifecycle, or existing vaults never get the rows:

- a full rebuild task, in `FULL_CACHE_REBUILD_TASKS` and `INBOUND_SYNC_CACHE_REBUILD_TASKS` when those paths can stale it (inbound sync and snapshot restore bypass `invalidations_for_op`);
- a `rebuild_*_from_base` arm in the reconciliation oracle (`src-tauri/src/reconciliation_oracle.rs`), folded in Rust from base tables, sharing no code with the maintenance path;
- a durable retry obligation: a failed rebuild must reach `materializer_retry_queue`, never live only in memory.

## Paths that add or remove derived rows

Before writing code that makes one path add or remove derived rows, list every path that must undo or repeat it: undo, redo, move (both directions), restore, the batch variant, inbound apply, and the boot rebuild. Restore and move carry descendants the per-op arm cannot see.
