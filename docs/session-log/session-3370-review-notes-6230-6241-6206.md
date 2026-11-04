# Session 3370 — review notes from #6230, #6231, #6233, #6235, #6238, #6241 and #6206

The follow-up for the non-blocking notes of a sweep that merged #6244 and #6245. Each note was re-checked against `origin/main` first.

**Fixed**

- #6230: `dump_is_space_flags` filters `value_text = 'true'` in SQL and returns the set `diff_spaces_registry` compares, so the Rust-side filter is gone. `spaces_registry_reconciles_with_is_space_and_reports_each_drift_6207` still covers both drift directions.
- #6241: `project_engine_dropped_refs` uses a `Cell<bool>`. No thread shares the closure, and the clean clippy and check runs confirm that nothing needs the future to be `Send`.
- #6233: the two `.nsprc` notes say the advisory, why it can't move, the reach and the exit condition, and nothing else.
- #6206 PR 4, a ref under a number, url or date key: the block drawer showed an empty input. It never read `value_ref`, and its mark's label read " doesn't fit Due". The field now shows the target's title. `RefPropertyChip`'s title lookup moved into `useRefTitle`, so the chip, the drawer and the row editor share it. The field remounts when a late title resolves, because the input reads its value once. The fix also closed a data-loss path: a ref under a *text* key fits, so the old untouched-save guard (`unfit && v === value`) didn't cover it, and a blur would have written the title as text. The guard now covers any shown title.
- #6206 PR 4, the number `1` under a select with option `"1"`: the disabled unfit item and the option both had the value `"1"`. The list showed "1" twice, and picking the option fired no change. On that collision only, the unfit item takes a sentinel value. Using the sentinel always would have changed what an existing test pins.
- #6238: `UnfitValueMark` in the row editor labelled a ref by its ULID. It now takes the resolved title.
- #6206 PR 5A, the stale list after a toast Undo: the note blamed query keys. The list itself is a query with `gcTime: 0`, so it re-reads on remount. The stale part was the usage counts, which were `useState`. Remove, leave, return, Undo: the Undo called the old instance's reload, and the new list never re-read, so its "N don't fit" badge stayed wrong. The counts now load with `useQuery` under the `propertyDefs` root, which `invalidatePropertyCaches` already reaches. `refetchOnMount: 'always'` keeps the old read-on-open, because the shared client never treats data as stale.

**Premise wrong, not applied**

- #6235, `oracle_is_date`'s `len == 10`: it is load-bearing. Chrono parses and prints `+10000-01-01` and `-0001-01-01` unchanged, which a scratch program confirmed, so only the length rejects a signed year.
- #6235, `comparable_definition` as a tuple: the string is also the divergence's printed form, and no value type holds a space, so two definitions can't collide. A tuple would need its own formatter.
- #6231, `UnacknowledgedPropertyLoss` called a misnomer: Remove and Convert still lose values, and a stale acknowledgement is refused because of that loss.
- #6241, a `project_pass_refs` bool parameter or `brings_new_block_rows` wrapper: `import_and_project` sits at the 70-line cap. #6245 also reshaped both: `brings_new_block_rows` now returns `NewRows`, and `project_pass_dropped`, which replaced `project_pass_refs`, takes it.

**Left as found:** two siblings came up while building. `loadDefinitions` has the counts' shape: Create, leave, return, Undo leaves the withdrawn definition listed until the list reopens. Fixing it means moving its local updates and loading state into a query. And the page Properties table still shows a ref under a number, text or url key as its ULID inside the input. Neither was in a note, and neither loses data.

**Lesson (#6206 review):** when a change renames an accessible name, grep `e2e-tauri/` for the old name as well as `e2e/`. The real-backend lane runs only at the gate, so a stale selector there shows up after merge.

**Suites:** the `#6207`, recovery and `#6236` nextest tests (223), clippy and the `sqlx prepare` of the root cache. Vitest over `src/components/properties`, `src/components/editor/__tests__` and `src/components/settings` (2112). Typecheck, oxlint and oxfmt. Seven Playwright property specs (44 tests). Every new frontend test was shown red first and again under a mutation of its fix.
