# Session 3229 — a property value its type can't hold is kept as text

#6206 slice 1 of 5. The maintainer's decision: one uniform model with no misfit table. Every engine property value gets a `block_properties` row in the column its own form takes, and nothing is hidden. Typed readers read their typed column, so they ignore a value that doesn't fit.

- `reproject_property_row_from_engine` now writes a `Str` that `coerce` refuses to `value_text`. Before, such a value was dropped and left row-absent. Every re-projecting path calls it: sync Pass A, the defs pass, recovery, retype, and the rewrite apply. The local apply writes the payload verbatim, as before; commands validate it. Dangling refs stay row-absent.
- A type change no longer writes removals for values it can't convert; they stay as text. The S3 vocabulary moves from `removed` to `unfit`: the counts field, the list kind, the dialog's "Don't fit" tab and its copy. The confirm button is no longer styled as destructive.
- An undo, redo or revert that restores a value the key's current type can't hold now restores it in the slot of its own kind instead of refusing with "change its type back first". The build plan had kept that refusal. It was reversed because `held_property_value` now records a kept value as `prior`, so undoing a by-hand fix of one would otherwise be refused.
- The query aggregate (`agg_target_expr`) folds `value_text` only for a key not declared number, date, boolean or ref. The per-row lookup runs on the `property_definitions` primary key. Without the gate, a kept `"2026-02-30"` passed the numeric GLOB guard and added 2026 to a sum.
- The mock matches: `fieldsUnder` fits a string before slotting it, `reprojectKey` keeps the row, and the refusal mirror is gone. The "KNOWN GAP" comment went with it.

**Traps.**
- `list_property_values` autocomplete now suggests kept values for any key; accepted, since nothing is hidden.
- Until slices 3 and 4, nothing lists or marks a kept value. The number editor shows it blank and the boolean editor shows it indeterminate. Chips and export show it.
- `CONFORMANCE_UPDATE=1` reorders the keys of four unrelated fixtures. Restore them from `HEAD` after checking they parse identical.

**Review.** A separate reviewer re-ran the reds: the projection drop (16 tests across projection, recovery, sync, commands and fixtures), the aggregate gate, the undo refusal, and three mock mutations. It added tests for the aggregate's boolean and ref arms and the projection's ref arm, and reworded the dialog description. It traced every undo path and every reader of `block_properties`.

**Suites:** full `cargo nextest run --workspace`, clippy, `SQLX_OFFLINE` check, the four `sqlx prepare --check` lanes, `cargo test --doc`, `conformance_fuzz`, full `npx vitest run`, typecheck, lint, `prek` (both stages), and 219 Playwright tests across the property, settings, agenda, query, undo, history, merge, space-move and template specs. `e2e-tauri/property-type-change.e2e.ts` was edited but not run: the box has no `tauri-driver`, so `e2e-tauri-gate` checks it. Bench probes renamed in `interactive_slo.rs` and `property_def_bench.rs` compile; `bench-smoke` is dispatched on the branch.
