# Session 1175 — Engine-convergence tests for undo of AddTag/RemoveTag/DeleteProperty (#2838)

## Scope

Test-only follow-up to #2655. That PR added a `drive_reverse_engine` helper (drives
the Loro engine in-tx inside `apply_reverse_in_tx` for undo/redo) plus
engine-convergence tests for undo of Delete/Restore/Edit/SetProperty — but the
**AddTag**, **RemoveTag**, and **DeleteProperty** reverse arms had no dedicated
test asserting the engine state converges with the SQL projection after undo. The
arms were believed correct (they mirror the forward `*_via_loro` paths); these
tests lock that in against the #891 engine/SQL-drift class.

## Change (tests only — no production code)

Three tests added to `src-tauri/src/command_integration_tests/undo_integration.rs`,
mirroring the #2655 harness (`test_pool`/`test_materializer`/`dispatch_via_engine`/
`undo_page_op_inner`/`redo_page_op_inner`/`settle`):

- `undo_redo_add_tag_converges_engine_2838` — forward AddTag, undo (reverse
  RemoveTag), redo (reverse AddTag); asserts `engine.read_tags(BLK)` and the SQL
  `block_tags` (via a new `sql_has_block_tag` helper) agree at every transition;
  pins `reversed_op_type`.
- `undo_remove_tag_converges_engine_2838` — tag present → forward RemoveTag → undo;
  tag absent after remove, restored after undo, in BOTH engine and SQL.
- `undo_delete_property_converges_engine_2838` — SetProperty → forward
  DeleteProperty → undo; property `None` after delete, restored to the prior value
  after undo, in BOTH `engine.read_property_typed` and the SQL `block_properties`
  (via a new `sql_property_value_text` helper).

## Result

No divergence found — the three reverse arms converge engine and SQL correctly.
`cargo check` + clippy `-D warnings` clean; full suite 3469 passed / 0 failed / 6
skipped; no `.sqlx` delta; no production code changed.

Closes #2838.
