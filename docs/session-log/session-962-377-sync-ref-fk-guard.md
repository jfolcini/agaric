# Session 962 — #377: guard inbound-sync ref re-projection against FK-abort

**Date:** 2026-06-03
**Scope:** SQL-review finding #377 (HIGH) — a dangling ref property can abort
inbound sync and wedge it.

## Symptom

`reproject_block_properties_from_engine` (loro/projection.rs) inserts a
`ref`-typed property straight into `block_properties.value_ref`, which has
`REFERENCES blocks(id)` (migration 0062, `ON DELETE CASCADE`) under
`PRAGMA foreign_keys = ON`. The engine can legitimately return a ref whose
target has no `blocks` row in this space — a cross-space reference, or a
forward reference to a block projected later in the same `changed_blocks` loop.
The unguarded INSERT then raises FK 787, which aborts the entire inbound-sync
`BEGIN IMMEDIATE` transaction; every retry hits the same point and fails
identically, **permanently wedging sync** for that peer/space. The sibling
`reproject_block_tags_from_engine` was already hardened against exactly this,
but the property path was not.

## Fix

Guard the INSERT the same way as the tags helper — insert only when `value_ref`
is NULL (no FK to satisfy) or its target block exists:

```sql
INSERT INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref, value_bool)
SELECT ?, ?, ?, ?, ?, ?, ?
WHERE ? IS NULL OR EXISTS (SELECT 1 FROM blocks WHERE id = ?)
```

A dangling/cross-space ref is **dropped** (row-absent), which is the only valid
representation: NULL-ing `value_ref` would leave an all-NULL row that violates
the `exactly_one_value` CHECK, and authoritative-replace already removed any
prior row via the up-front DELETE. The guard keys on row existence (not
`deleted_at`), so a ref to a soft-deleted-but-present target is preserved —
matching the FK itself and the tags sibling.

Out of scope (noted, not a bug here): `project_set_property_to_sql` (the local
command/op-log write path) is unguarded but only ever sees locally-produced,
same-space, validated refs — not remote engine output.

## Verification

- New regression `reproject_skips_dangling_ref_without_fk_abort_377`: a ref to
  a non-existent target must not FK-abort and must be dropped (row-absent). The
  positive case (a ref to an existing block IS inserted) stays covered by
  `reproject_routes_ref_value`, so together they prove the guard is selective.
- `cargo nextest`: 17/17 reproject tests, 174/174 `loro::` + `sync_protocol::`.
- `cargo sqlx prepare -- --tests` re-run (new guarded-INSERT entry replaces the
  old unguarded VALUES entry).
- Independent review confirmed binding order (9 binds → 9 placeholders), guard
  semantics, the no-over-drop property, and soft-delete behavior.
