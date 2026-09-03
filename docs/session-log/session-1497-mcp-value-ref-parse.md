# Session 1497 — `set_property`'s `value_ref` was waved through

A fifth instance of the defect session 1488 fixed four of, found while reviewing the fourth. Session 1488 is merged, so the correction lives here rather than in it: its closing paragraph says four gaps and four tests, and the count is five.

`handle_set_property`'s schema calls `value_ref` a "Block ULID reference", but the handler only uppercased it and stored it verbatim. Nothing downstream catches a malformed one: `validate_ref_property_cross_space` tolerates a target that resolves to no space, because an orphan target is not a cross-space violation. `set_property_in_tx` appends the op before it projects, so the malformed ref landed in the op log and the Loro engine, where nothing later removes it; the SQL projection's `EXISTS (SELECT 1 FROM blocks …)` guard dropped the `block_properties` row, so the tool answered `Ok` for a property that did not exist, with no error for the agent to retry against. It parses through `BlockId::from_string` now.

`block_id` and `space_id` in the same handler stay on the loose `normalize_ulid_arg` deliberately, and that is the line the fix stops at: both feed `validate_block_in_space` / `verify_active`, which answer `NotFound` for a malformed id rather than silently succeeding. `value_ref` had no such backstop, which is the whole difference.

`set_property_malformed_value_ref_errors_rather_than_dangling` pins both arms: three malformed refs error, and a lowercase well-formed one is accepted and stored uppercase — so the boundary normalisation the parse replaced is not quietly lost. Falsified against a copy of `tools_rw.rs` with the parse reverted to `normalize_ulid_arg`, then restored and `cmp`-checked.

The rest of #3301 landed in #4621; the two change-notification findings in the issue body stay dropped.
