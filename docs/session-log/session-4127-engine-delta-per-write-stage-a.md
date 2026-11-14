# Session 4127 — a `loro_doc_delta` row for every engine write (#6521, stage A)

`Refs #6521`. Stage A of option (2) from the spike (session 4096): every write to a space's Loro engine saves, in a transaction, the update it added, in the one table the maintainer approved. Boot is unchanged apart from one delete, nothing reads the rows in production, and a test oracle rebuilds every engine from its saved rows.

## What shipped

Migration 0132 creates `loro_doc_delta (id AUTOINCREMENT, space_id, bytes) STRICT`, with no index: its readers take every row in `id` order or delete one space's rows during a pass.

Where each engine write saves its row (`agaric-engine/src/loro/delta.rs`):

- **A transaction that arms the rollback log.** `RevertLog` now records the engine's version vector beside the frontier at first touch, and `commit_with_deltas` exports each engine's update since it and inserts it before the commit. `CommandTx` (every local command, undo and redo, batch ops, bootstrap, the boot repairs and hydrations, the empty-block sweep) and the materializer's `apply_op` and batch/replay transactions commit through it. A failed export or insert rolls the transaction back and rewinds the engine. An engine the transaction only read saves nothing, and neither does one the registry no longer holds (a purged space's, evicted in that transaction).
- **The engine writes that follow a commit**: the cohort fan-outs of delete, restore and a move's re-derived tombstones (`materializer/handlers/apply.rs`), the three purge commands' engine purge (`commands/blocks/crud.rs`), and the tombstones a sync projection swept. `write_engines` runs them under the write lock in a transaction of their own. `merge::engine_apply` takes the fan-out's own log.
- **A sync import**, which writes the engine before its projection transaction opens: `LoroEngine::capturing_delta` exports what the import added, under the engine lock, and the projection transaction saves it where it clears the inbox slot. The trusted no-op path saves it before its slot delete; when the projection does not commit it is saved on its own.
- **The export's format stamp, the tombstones `mirror_sql_tombstones_onto_engine` writes, and the sibling-order migration a rehydrate can append**: `capturing_delta`, then an insert (the mirror's in the transaction it already holds).

A snapshot pass reads the newest delta id before it collects any engine and deletes each saved space's rows up to it in the transaction that writes the snapshot row. The purge of a space deletes its rows.

## Departures from the findings, and why

- **A sync import saves what the engine gained, not the inbound blob.** An import can append this device's own ops: the one-time sibling-order migration, and since #6561 the moves that keep local blocks a remote purge would have taken, which landed on `main` while this was in review. It can also leave part of a blob pending. The blob holds none of the first and all of the second.
- **Boot deletes the rows an earlier process left** (`rehydrate_registry`). Boot still builds engines from the snapshots and replays the op log, and a replayed op mints new Loro ops under the ids the dead process's rows hold; kept, those rows would rebuild another state under the same version. What boot writes saves rows of its own.
- **A post-commit write stands when its delta cannot be saved** (the lock times out, the insert fails). The first build rewound it, which the review showed is a regression: before this change the cascade always reached the engine, and a restore or a purge that does not is a divergence peers see. The gap lasts until the next snapshot pass saves the space.
- `CommandTx::commit_and_dispatch` and `commit_without_dispatch` return `AppError`, since a failed export is not an `sqlx::Error`.

## The oracle

`delta::saved_engine_divergences` rebuilds each space from its snapshot, its deltas in `id` order, the blobs `loro_sync_inbox` and `loro_sync_quarantine` still hold, and what fixtures seeded, and compares version and state with the live engine. `Materializer::assert_saved_engines_match_live` panics on a divergence; the shared `settle` helper calls it, and so does each step of the two-device harness in `spaces/session_save_tests.rs`. So the conformance fixtures, the differential fuzz and most command tests run it after every op.

Traps it hit, all test artefacts:

- Loro lists a root container in the state once a reader has looked it up, empty or not. The comparison ignores empty roots.
- A fixture that writes through a materializer of its own (`bootstrap_spaces_for_test`, `ensure_test_space_with_defs`, `create_test_property_def`) saves deltas for engines the test's materializer does not hold, and the test's engine then reuses their op ids. Each drops the rows it saved.
- Fixtures that write an engine directly go through the new test-only `LoroEngineRegistry::seed`, which the oracle counts as saved (`conformance.rs`, `undo_redo_tests.rs`). One that called the apply kernel on a bare connection now uses the transaction shape the materializer uses, with `BEGIN IMMEDIATE`: a deferred transaction that upgrades fails at once with "database is locked" under a background writer, which showed as one test passing only on retry.

After those, the whole suite ran with the oracle and no production path was found writing an engine without a row.

## Left open, for stage B (in the issue comment)

- The fan-outs save their delta after their op's transaction, so window 5 is as it was.
- A write whose delta was not saved leaves later rows depending on ops no row holds until a pass saves the space. Harmless while nothing reads the rows; stage B has to decide what a boot does with it.
- `mirror_sql_tombstones_onto_engine` and #6561's `save_kept_blocks` call `save_all_engines` outside the one-pass lock (window 6). An older export written after a newer one now also deletes deltas the surviving row lacks.

## Measurements

`agaric-engine/src/loro/durability_cost_tests.rs` gained two cases that time stage A as built, each against the same write without its delta, interleaved; the command is in its module doc. Release build without LTO, a 4-core cloud container, two runs; each cell is the two runs' medians, then the lowest and highest sample of either run. 10 edits per block.

| | 10K blocks | 100K blocks |
|---|---|---|
| One edit's transaction, no delta | 0.16–0.22 ms [0.11–0.77] | 0.16–0.17 ms [0.12–1.07] |
| One edit's transaction, with its delta | 0.22–0.36 ms [0.19–1.80], 90 bytes a row | 0.21–0.25 ms [0.17–1.84], 92 bytes a row |
| Import of 1000 edits, no delta | 24–36 ms [20–40] | 62–68 ms [62–78] |
| Import of 1000 edits, with its delta | 26–32 ms [21–43], 13 KB a row | 63–68 ms [61–83], 13 KB a row |

Read as direction: the delta adds under a tenth to a seventh of a millisecond to an edit's transaction, and the two arms' ranges overlap. For the import the arms are inside each other's noise; with no edit history the delta arm sits 2 to 4 ms higher at both sizes. Neither cost grows with the space: the 10K and 100K edit samples overlap, and the import's own growth is the index rebuild the spike already noted.

## Review

One independent read of the commit path by a second model before the gates. Acted on: the rewound cascade above; an import whose projection fails and whose retry clears the slots left ops in no row (now saved on its own, with a test); `capturing_delta` dropped what a write added before it failed (it no longer reads the write's result). Its window-6 finding is in the list above. Not acted on: the harness stays, since the numbers above come from it.

## Tests changed, and why

- `db/command_tx.rs`, the rollback test: the async block's error type is `AppError`, as the commit's now is. No assertion changed.
- Five fan-out call sites in tests take the pool, and five `engine_apply` call sites take a log.
- The fixtures named above.

## Ran

On the merge of `origin/main` at `875512b`: `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo nextest run --workspace` in two halves (4068 and 4059 tests pass, none on a retry), the doc-tests, and `just gen-sqlx` and `just gen-bindings`, which leave no diff. On an earlier merge (`67d9b68`): `prek run --hook-stage manual --all-files`, `npm run typecheck`, `npm run lint` and the full vitest (26943 pass); only Markdown changed outside `src-tauri`, and the five `main` commits since touch none of this branch's files. Not run: Playwright and WebdriverIO (no frontend or command-surface change), and no bench lane (no SQL an SLO probe times changed; the per-write cost is the table above).

Every new test was shown red once, one guarded mutation per command: 24 mutations, each killed on the assertion predicted. Removing the delta write from the post-commit fan-out reddened `delete_block_reports_cascaded_nested_pages_4523`, a test that knows nothing of deltas, through `settle`.
