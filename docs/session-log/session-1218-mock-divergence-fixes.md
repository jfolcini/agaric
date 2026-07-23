# Session 1218 — Fix three JS-mock-vs-real-backend divergences

**Issues:** #3079, #763

## Problem

The mock-vs-real conformance harness (#763) surfaced three handlers where the JS Tauri mock
silently disagreed with the real Rust backend:

1. **`purge_block` did not cascade.** The mock only did `blocks.delete(target)` — it left the
   entire descendant subtree and every satellite row (`block_properties`, `block_tags`)
   behind. The backend (`purge_block_inner` → `descendants_cte_purge!()` +
   `purge_subtree_tables`) physically deletes the whole subtree — active OR tombstoned — plus
   its satellites.

2. **`set_property` with a reserved key mis-routed.** The mock stored *every* key in the
   `properties` map. The backend's `reserved_key_blocks_column`
   (`agaric-store/src/db/mod.rs:332`) routes `todo_state` / `priority` / `due_date` /
   `scheduled_date` to the same-named **`blocks` column**, never a `block_properties` row —
   so the mock double-counted them (once on the column, once as a spurious property row).

3. **`delete_property` with a reserved key was a silent no-op.** The mock only deleted from
   the `properties` map; a reserved key lives on the column, so nothing was cleared. The
   backend routes the delete through `reserved_key_blocks_column` and clears `blocks.<col>`.

## Fix

Confined to the two mock handler modules + three conformance fixtures.

1. **`src/lib/tauri-mock/handlers/blocks.ts`** — `purge_block` now BFS-walks the full
   descendant subtree via `parent_id` (no `deleted_at` filter, matching the purge CTE) and
   physically deletes each block plus its `properties`/`blockTags`/`attachments`/`pageAliases`
   satellites (the per-id cleanup `purge_blocks_by_ids` already did, now with the descendant
   cascade). Returns the true cohort size as `purged_count`.

2. **`src/lib/tauri-mock/handlers/properties.ts`** — a shared module-level
   `RESERVED_PROPERTY_COLUMN` map + `setReservedColumnProperty` helper:
   - `set_property` routes a reserved key onto the block column (value channel:
     `todo_state`/`priority` ← `value_text`; `due_date`/`scheduled_date` ← `value_date`) and
     appends the op with `from_value: null` — no `block_properties` row is written.
   - `delete_property` clears the corresponding block column for a reserved key instead of
     touching the (empty) properties map.

3. **3 new conformance fixtures** (`conformance/fixtures/*.json`), each with a
   backend-authored `expected` (`CONFORMANCE_UPDATE=1` against the real Rust runner):
   `purge_subtree_with_satellites`, `set_property_reserved_key_routes_to_column`,
   `delete_property_reserved_key_clears_column`. Each seeds only `blocks` (no seed
   properties/tags) to keep op_log_digest parity between the TS direct-store seed and the
   Rust op-log path.

## Verification

- `cd src-tauri && NEXTEST_TEST_THREADS=4 cargo nextest run -E 'test(conformance_fixtures_match_backend)'`
  → 1 passed (re-run WITHOUT `CONFORMANCE_UPDATE` proves the fixtures are backend-authored).
- `npx vitest run src/lib/tauri-mock/__tests__/conformance.test.ts` → 26 passed (incl. 3 new)
  — proves the mock now matches the same backend-authored `expected`.
- `npx vitest run src/lib/tauri-mock` → 202 passed (handler-fix regression check).
- Adversarial-review follow-up: updated stale unit tests in
  `src/lib/__tests__/tauri-mock.test.ts` that encoded the OLD divergent behaviour
  (a purge-parent test asserting children survive — "mock doesn't cascade"; and
  generic property-CRUD tests using the reserved key `priority` and expecting a
  `block_properties` row). Purge test now asserts the descendant cascade; property
  tests now use a non-reserved key (`category`). This file is outside the
  `src/lib/tauri-mock` glob above, so it was not exercised by the original run.
- `npx vitest run` (full FE suite) → 712 files / 15631 tests passed.
- `npx tsc -b` → 0 errors; `npx oxlint` on changed handlers + test → 0.
