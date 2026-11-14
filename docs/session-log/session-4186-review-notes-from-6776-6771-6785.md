# Session 4186 — Review notes from #6776, #6771, #6780 and #6785

The follow-up PR for the non-blocking notes of the merged PRs #6776, #6771, #6780 and #6785, and #6521's decision 3. A stopped session started it; this one reviewed its commit against `main` and finished it. Numbers 4181, 4183 and 4184 are held by open PRs, so this log is 4186.

## What shipped

- **#6776: a query table cell's write reads nothing back.** `usePropertySave` takes `setProperties` as optional, and `handleSaveProperty` calls `get_properties` only when it has a list to hand the result to. The cell passed a no-op setter, so each write paid for a read it threw away, and a read that failed after the write showed "save failed" beside the "updated" toast. The cell now passes no setter.
- **#6771: the vacuous `dirty_count` assert is deleted** from `prepare_outgoing_exports_when_its_stamp_delta_cannot_be_saved`. The seed block's `for_space` guard already left the space dirty, so nothing `prepare_outgoing` did could fail it. The over-long comment line in `record_background_failure` is re-wrapped.
- **#6785: `RepairOp::Delete::effects` is gone**, with the boxed `ApplyEffects` built for it. Its one reader was a test's cohort assertion. That test still pins the cohort without it: the delete op exists, and no child is deleted.
- **#6780: `e2e/AGENTS.md` § "The real backend, through the bridge"** has its three stale statements corrected, as the maintainer's comment on #6780 allows: the vault holds the mock's seed written through the real commands, `SEED_IDS` name the seeded rows, and the nightly `full-suite` lane runs the `real-backend` project. No other sentence of that file and no other `AGENTS.md` changed.
- **#6521 decision 3: a space purged through a command drops its engine and its saved rows**, as the applied purge does. `purge_subtree_tables` deletes the member set's `loro_doc_state` and `loro_doc_delta` rows, so all three purge commands (`purge_block`, `purge_blocks_by_ids`, `purge_all_deleted`) do it in the op's transaction. `dispatch_purge_engine_fanout` evicts every purged block that keys an engine, after its engine writes and before the commit.

## Decisions and traps

- **The eviction is before the commit, not after.** `DetachedRevert::deltas` skips an engine the registry no longer holds. `purge_all_deleted` that purges a space and one of its pages writes that space's engine in the same transaction (the page's fan-out); evicted after the commit, the commit would save a fresh delta row for the dead space. The test shows this: without the eviction it finds `(0, 1)` rows. The trade is the applied purge's own: a commit that fails after the eviction keeps the rows without their engine until the next boot.
- **Evicting by cohort id, not by a `spaces` lookup.** Registry keys are space ids, so evicting each purged id evicts exactly the purged spaces, and the cohort is already captured before the cascade removes the `spaces` row.
- **Not done: `property_definitions`.** The applied purge also deletes a purged space's property definitions (#5841); the command's purge does not. The maintainer's decision named the engine, snapshot and delta rows only, and an orphaned definition row is read by no space.
- **`next-session-log.mjs --rename` picked 4184**, which open PR #6788 holds; the plain run had printed 4186. Renamed by hand.

## Dropped, with the reason

- **#6776, the inline `onWritten` closure in `CellEditor`:** nothing in the cell keys on the identity of `handleSave` or `handleDelete` (`commit` is a plain function built each render), so memoizing the closure changes nothing a user or a test can see.
- **#6780, a seed page whose title matches a first-boot page:** the note itself says today's seed does not hit it and that `seedVault` fails loudly if it ever does.

## Shown red

- `usePropertySave.test.ts`: `handleSaveProperty` reading back unconditionally.
- `*_on_a_space_leaves_no_engine_and_no_rows_6521` (three, one per purge command): before the fix, all three found the rows; with the eviction removed, `purge_block` and `purge_blocks_by_ids` keep the engine and `purge_all_deleted` saves a delta row; with the row deletes removed, all three find `(1, 3)` rows.

## Suites run

`cargo clippy --workspace --all-targets -- -D warnings`; `cargo nextest run --workspace`, the full run; `npm run typecheck`; vitest on `usePropertySave`, `property-save-utils` and the query table cell tests. Not run: Playwright and the real-backend lane; CI's runs are the check.
