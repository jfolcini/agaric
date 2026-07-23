# Session 1203 — Tear down loro_doc_state + per-space engine on space purge

**Date:** 2026-07-23
**Branch:** `fix/space-purge-snapshot-leak`
**Closes:** #2910

## Summary

Purging a space's page block correctly removed its `spaces` registry row (ON DELETE CASCADE
FK, migration 0089) but **permanently leaked** the space's `loro_doc_state` snapshot row and
its in-memory per-space engine: no production per-space `DELETE FROM loro_doc_state` existed,
the registry had no per-space eviction API (only clear-all), and boot `rehydrate_registry`
unconditionally reinstalls an engine for every persisted `loro_doc_state` row — so a dead
space's Loro doc (with its full CRDT history) was rehydrated at every boot and re-persisted by
the periodic saver forever.

## The fix (3 files)

- **`agaric-engine/src/apply/loro_apply.rs`**
  - In `purge_block_sql_cascade`: added `DELETE FROM loro_doc_state WHERE space_id IN (SELECT
    id FROM _purge_descendants)` among the sibling cascade deletes (same tx, before the final
    `DELETE FROM blocks`), so it is atomic with the purge. `_purge_descendants` includes the
    **root** purged block at depth 0, and a space's `loro_doc_state.space_id` == its page-block
    id, so the space's OWN row is deleted (and any nested registered spaces in the subtree).
    Over-delete is impossible (ids are globally-unique ULIDs). Runtime `sqlx::query` (dynamic),
    so `.sqlx` is unaffected.
  - In `apply_purge_block_via_loro`: probe `EXISTS(SELECT 1 FROM spaces WHERE id = ?)` for
    `p.block_id` **before** the cascade removes the `spaces` row; after the cascade and after
    any engine guard is dropped, call `registry.evict_space(SpaceId(p.block_id))` if it was a
    registered space.
- **`agaric-engine/src/loro/registry.rs`** — new `evict_space(&self, space_id)`: removes the
  map entry (detached-engine contract — in-flight ops holding the `Arc` complete against the
  detached engine; later `for_space` lazy-creates fresh), bumps `generation` **only when an
  entry was removed** (so a concurrent `save_all_engines` re-checks generation and aborts
  before resurrecting the deleted row), then clears the dirty flag. Takes only the outer MAP
  lock (never an engine lock) → cannot deadlock. Faithfully replicates the established `clear`
  race protocol (#607).
- **`agaric-engine/src/loro/snapshot.rs`** — two tests.

## Safety

A purged **space** block has NULL `blocks.space_id`, so `resolve_soft_deleted_block_space`
returns `None` → the SQL-only fallback arm, where no engine guard is held. Eviction therefore
never targets a mid-apply engine (the guard, when held, is on a *different* owning space and is
`drop`ped before the cascade/evict). The save-race window is closed to the same degree as the
existing `clear`: `save_all_engines` re-checks `generation` at the top of **every** write
iteration (not just at collect time), and the generation bump + the DELETE occur in the same
purge transaction before commit.

## Tests (non-tautological, mutation-verified by review)

- `purge_registered_space_deletes_snapshot_and_evicts_engine_2910` — purges a registered space
  via a real deferred-FK tx; asserts the `loro_doc_state` row is gone AND the engine is evicted,
  while a KEEP control space's row+engine survive (scoping).
- `purged_space_is_not_rehydrated_at_next_boot_2910` — after purge, runs the real
  `rehydrate_registry` and asserts only the surviving space rehydrates (the regression guard).
- Independently reproduced: gating off the DELETE (`AND 1=0`) and the evict (`&& false`) fails
  both tests at distinct assertions (row-teardown vs engine-eviction are separately guarded).

## Verification

`cargo nextest` over the space/purge/snapshot/registry/rehydrate/evict slice = **659 passed,
0 failed**. `cargo clippy --workspace --lib --tests -- -D warnings` clean. `.sqlx` unchanged.
