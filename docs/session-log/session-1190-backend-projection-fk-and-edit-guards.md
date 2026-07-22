# Session 1190 — Backend projection: FK guard + soft-deleted edit fidelity

**Date:** 2026-07-22
**Branch:** `fix/backend-projection-fk-and-edit-guards`
**Closes:** #2908, #2909

## Summary

Two backend correctness fixes in the Loro→SQL projection path
(`src-tauri/agaric-engine/src/loro/projection.rs`), both surfaced by the
2026-07-22 analysis report. The engine is the source of truth; these bring the
SQL projection back into agreement with it in two edge cases where it silently
diverged (or aborted).

## #2908 — Dangling `value_ref` FK guard on `project_set_property_to_sql`

Migration 0062 declared `block_properties.value_ref REFERENCES blocks(id) ON
DELETE CASCADE`. The command-path property projection wrote the row
unconditionally, so a `SetProperty` carrying a `value_ref` pointing at a block
that no longer exists in SQL raised foreign-key error 787 and aborted the
projection.

The sync-path twin `reproject_block_properties_from_engine` (#377) and boot
recovery (#2043) already guard this by dropping a dangling ref to *row-absent*.
This mirrors that exact guard into the command path:

```sql
INSERT OR REPLACE INTO block_properties
  (block_id, key, value_text, value_num, value_date, value_ref, value_bool)
SELECT ?, ?, ?, ?, ?, ?, ?
WHERE ? IS NULL OR EXISTS (SELECT 1 FROM blocks WHERE id = ?)
```

Binds (9): the 7 SELECT columns in table order, then `value_ref` twice (the
`? IS NULL` test and the `EXISTS(... id = ?)` test). The guard sits only in the
non-reserved-key branch — the only branch that writes `block_properties.value_ref`.
The reserved-key and `space` branches write to `blocks` columns (the latter
already guarded against its own `spaces` FK, #708).

## #2909 — `EditBlock` on a soft-deleted block

`project_edit_block_to_sql` carried `AND deleted_at IS NULL`, so an edit applied
to a soft-deleted (tombstoned) block was dropped from SQL while the engine
applied the diff-splice — a silent content divergence between the two stores.
Dropped the filter: `UPDATE blocks SET content = ? WHERE id = ?`. Writing to a
tombstoned row is harmless (all reads filter `deleted_at`) and does not
resurrect it (the UPDATE never touches `deleted_at`).

The undo path (`src/commands/history.rs`) keeps its own distinct query with
`AND deleted_at IS NULL` — it intentionally treats a zero-row update on a
soft-deleted block as `NotFound` — so that `.sqlx` cache entry is retained.

## Tests

- `project_set_property_dangling_value_ref_is_row_absent_no_fk_787` — dangling
  ref lands row-absent, no FK 787 (verified `PRAGMA foreign_keys = ON` via
  `test_pool`, so the test genuinely exercises the constraint).
- `project_set_property_existing_value_ref_is_stored` — happy path.
- `project_edit_block_updates_soft_deleted_content_without_resurrecting` —
  content tracks the engine while `deleted_at` stays set.

Full suite: `cargo nextest run -p agaric-engine` → 399 passed, 0 failed. Clippy
clean. `.sqlx` offline caches regenerated for both crates.

## Non-blocking follow-up

Unlike the twin (which DELETEs all rows first), the command path has no up-front
delete, so if an existing valid `(block_id, key)` row is later overwritten by a
`SetProperty` carrying a *dangling* ref, the guarded `INSERT OR REPLACE` matches
zero rows and the stale prior row persists. Strictly better than the pre-fix FK
abort and consistent with the row-absent contract; noted for completeness only.
