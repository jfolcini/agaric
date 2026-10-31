# Session 3230 — review the values that don't fit in Settings › Properties

#6206 slice 3 of 5. It builds on slice 1 (#6231), which keeps a value its key's type can't hold in `value_text`. This slice adds a way to find those values and fix them in bulk.

- **One `sqlx::query!` predicate, `unfit_values` (`commands/property_unfit.rs`).** The count, the list and both actions share it.
  - The rule is the column rule of `declared_type_admits_shape`: text takes text or ref, url takes text, and the other types take only their own column. A select's text must also be one of its options.
  - Built-ins count; `space` and `is_space` don't.
  - Its scope, `+b.space_id = ?1 OR +b.id = ?1`, matches `project_property_value_writes`, so the count equals what Remove deletes.
- **`count_property_usage`** also returns, per key, `unfit` (live) and `unfit_in_trash`.
- **`list_unfit_property_values`** pages them by block id.
- **`remove_unfit_property_values`** writes one `rewrite_properties` op (reason `remove_unfit`) with a `prior` for each value, so one undo restores them all.
  - It is refused on a stale acknowledgement.
  - It writes no op when there is nothing to remove.
- **`add_unfit_values_to_options`** writes one `SetPropertyDef` with the sorted union of options, computed in the transaction. It writes no op when nothing changes.
  - The maintainer had written "each action is one `rewrite_properties` op". This reuses the options write instead: adding options loses nothing, its undo is never refused, and computing the union server-side keeps an option another device adds at the same moment. Posted on #6206.
- **Settings:** an amber "N don't fit" badge sits beside the use count. It opens a dialog on desktop and a sheet on a phone, listing page › block, the value and what is wrong, plus "N more in the Trash". The actions are Remove (destructive), Add to options (user-defined selects only), and Undo on the toast.
- **Mock, History label, user docs.**

**Traps.**
- With `sqlite_stat1` present (a vault after the periodic optimise), the planner started from every property row of the vault. `CROSS JOIN` keeps the definitions as the outer loop, as `PAGES_METADATA_FROM` does. No plan test pins it, because a stats-free test stays green with the fix reverted.
- Local commands refuse misfits, so fixtures make them through user paths only: narrowing a select's options and a type change. A raw misfit op passes in Rust but the mock refuses it.
- A Remove followed by its undo leaves the final snapshot equal to the start, so a no-op Remove would pass. The fixture removes again after the undo.
- A key whose only misfits are in the Trash shows no badge (live-only, decision (b)). Restoring the block shows it.

**Review.** A separate reviewer re-ran the reds:
- the predicate arms, the scope and the built-in options;
- the stale recount;
- Remove's `prior`;
- the mock's options arm;
- the select-only Add button.

It fixed the plan above and added tests for the scope, a built-in select and a boolean or date `prior`. It also turned a false "Added" toast into "nothing to add".

**Suites:** full `cargo nextest run --workspace`, clippy, `SQLX_OFFLINE` check, the four `sqlx prepare --check` lanes, `cargo test --doc`, full `npx vitest run`, typecheck (app and e2e-tauri), lint, `prek` (both stages), and the Playwright specs matching `propert|setting|history|mobile`. `e2e-tauri/property-unfit-values.e2e.ts` has never run (no `tauri-driver` here); `e2e-tauri-gate` is its first run.
