# Session 1037 — audit fix #1253: guard project_set_property_to_sql against all-NULL row

2026-06-15. From the 2026-06 Opus quality audit (correctness). `/loop /batch-issues` run.

## Bug
In `project_set_property_to_sql` (`src-tauri/src/loro/projection.rs`), the non-reserved
else-branch did an unconditional `INSERT OR REPLACE INTO block_properties (...)`. A
`SetProperty` op whose five typed value fields are all None produces an all-NULL row,
violating the `exactly_one_value` CHECK (migration 0062) and aborting the apply/replay
transaction. Reachable on the replay paths that bypass `validate_set_property` —
undo/redo replay and the engine-less SQL-only fallback (e.g. a corrupted or
older/newer-version op-log entry).

## Fix
When all five value fields are None, `DELETE FROM block_properties WHERE block_id=? AND
key=?` and early-return instead of inserting the all-NULL row. DELETE (clear →
row-absent) mirrors the sibling `reproject_block_properties_from_engine` guard and the
live path's intent. The DELETE query reuses an existing `.sqlx` cache entry already on
main — no `.sqlx` churn. No specta change. Defense-in-depth: the live command path is
fronted by `validate_set_property`, so this case never reaches it there.

## Verification
New test `project_set_property_all_none_non_reserved_is_row_absent_no_check_abort` seeds
a prior `value_num` row, drives the all-None op, asserts no CHECK abort and the row is
absent. Targeted: 53 passed. Reviewer ran the full Rust suite (4166 passed) + clippy
clean, confirmed DELETE is the right semantics, and restored `.sqlx` to main after the
build step had wrongly pruned 45 live entries against a stale dev.db.

Side note (separate chore): 45 gcal `.sqlx` entries are orphaned on main (commit
fd1c28a3) — tracked separately, not in this PR.
