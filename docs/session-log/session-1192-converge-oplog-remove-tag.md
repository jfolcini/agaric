# Session 1192 — Converge the `remove_tag` op-log interpreter onto the shared projection

**Date:** 2026-07-22
**Branch:** `refactor/converge-oplog-interpreters`
**Refs:** #2894 (first convergence; the broader dedup continues in follow-ups)

## Summary

#2894 observes that the meaning of each op-log op is re-implemented in 4+ places
(kernel `apply_op_tx`, `sql_only` fallbacks, the recovery interpreter in
`src/db/recovery.rs`, command orchestration), so a fix to one can silently miss the
others. This lands the **first safe convergence** — the `remove_tag` arm of
`recover_derived_state_from_op_log` — and documents, arm by arm, why the rest must
stay divergent for now (correctness over completeness).

## The one convergence

The recovery `remove_tag` arm previously inlined
`DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?`. It now calls the shared
`crate::loro::projection::project_remove_tag_to_sql(&mut tx, block_id, tag_id)`.
Proven byte-for-byte equivalent (same table, WHERE clause, bind order, 0-row no-op,
no usage-count/FTS side-effects, no FK guard — correct, since a DELETE cannot create
a dangling ref). A DELETE is the safest op to converge first.

## Why the other arms stay divergent (audited, not assumed)

- `add_tag` — recovery wraps the bare `INSERT OR IGNORE` in an `EXISTS(block) AND
  EXISTS(tag)` guard; under `foreign_keys=ON` at boot a dangling ref would wedge boot
  (FK 787). The shared helper has no such guard. (Asymmetric with `remove_tag` on
  purpose.)
- `set_property` — recovery guards **block_id existence** (#605/#708); the projection
  guards value_ref + space-registry (post-#2908) but still not block_id.
- `create_block` (#1536) — runs against a constraint-free pre-migration-73 TEMP table
  with explicit NULLs + a duplicate-corruption warn; not expressible via the
  real-schema `BlockSnapshot` projection.
- `delete_block`/`restore_block` — the #618 TEXT/INTEGER `deleted_at` type-era stamp
  is not expressible through the i64-only projection, and recovery's flat
  `(seed, deleted_at_ref)` cohort differs from the projection's connected-cohort +
  ancestor walk (#1055/#1884) — converging would change which blocks un-delete.
- `move_block` — recovery binds `Option<i64>` to preserve a `position=NULL` write on
  the both-indices-absent corruption path; the projection binds non-null `i64`.

## Fixes during review

Corrected a factually-wrong comment this change added to the `move_block` arm (it
misattributed the `i64::MAX` sentinel to the move path — it is produced by
`apply_create_block_sql_only`; the move path caps strictly below `NULL_POSITION_SENTINEL`
and does run the shared `move_would_cycle` probe). Precisely the comment-drift class
#2894 exists to eliminate.

## Tests

Two conformance tests drive the real production replay path
(`recover_derived_state_from_op_log(&pool, true)` against a fully-migrated schema) and
assert settled `block_tags` state: the removed pair is absent while an
independently-added pair survives (positive control), and removing a never-added pair
is a no-op leaving the real tag intact. Break-test proven (no-op'ing the converged call
fails the load-bearing assertion). Full suite: 3285 passed; clippy clean.
