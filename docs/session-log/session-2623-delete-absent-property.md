# Session 2623 — deleting a property the block doesn't hold appends no op, so the page's undo keeps working

#5898: `delete_property` on a key the block doesn't hold appended a `delete_property` op that has no prior value. When undo reached it, it failed with `NotFound` and aborted the whole page group, so Ctrl+Z on that page was stuck.

**Fix:** `delete_property_core` appends the op only when `property_is_held` finds the key. Otherwise it returns success with no op refs.
- For a column-backed key, held means the column is non-NULL. This reads `reserved_key_blocks_column`, the existing mapping.
- For any other key, held means a `block_properties` row exists.

The frontend already treats empty `op_refs` as a no-op (`onNewAction`, `useSlashCommandProperty`). #5074 applies the same rule to todo timestamps. `/repeat-limit remove` on a block with no `repeat-count` stops appending an op that couldn't be undone.

**Mock and fixtures:**
- The mock's `delete_property` returns `op_refs: []` for an absent key and appends nothing.
- `delete_property_absent_key.json` is new: it deletes two absent keys, then undoes the page group.
- `delete_property_system_managed.json` loses its absent `repeat-count` op.
- `restore_page_to_op.json` drops its second half. It replayed a raw priorless op on the backend while the mock ran the command, and after this fix the two can no longer produce the same op. No seed can rebuild it either: both runners seed a property through `set_property`, so the log always holds its prior.
- The backend rule that op pinned is still covered by `reverse_delete_property_without_prior_returns_not_found` and `compute_reverse_batch_aborts_on_a_fatal_non_skippable_error_4656` (`agaric-engine/tests/reverse_tests.rs`). The mock's mirror of it (`not_found`, raised before anything is reverted) moves to two tests in `undo-op-refs.test.ts` that give the mock a property no op wrote.

**Docs:** the `WithOps` doc (and its copy in `bindings.ts`) said `delete_property` appends its op even when the key is absent, and that no command answers an empty `op_refs`. It now names this case.

Shown red with the op always appended:
- `undo_page_group_survives_deleting_absent_properties` fails on the predicted `NotFound`;
- the backend conformance check fails;
- four mock tests fail.

Ran: `cargo nextest run --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `npm run typecheck`, `vitest run src/lib/tauri-mock`.
