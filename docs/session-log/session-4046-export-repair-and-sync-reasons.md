# Session 4046 — The export repairs an engine-live, SQL-deleted block; a refused space and a forked device say why

One PR for three items on the same path, a space's outbound sync export and what the user is told about it: #6565's one box, and the two messages #6523 still had open. #6657 had shipped #6523's other two; #6676 carries its "a press on Sync clears backoff" decision and is not touched here.

## What changed

- **The export repairs before it refuses (#6565).** `loro_sync::prepare_outgoing` finds a block live in the engine that SQL has soft-deleted, calls `mirror_sql_tombstones_onto_engine` once, and exports if that settled the space. The mirror holds the write lock, re-reads `deleted_at` under it, stands down while the space has a `loro_sync_inbox` or `loro_sync_quarantine` row, writes only what the engine still holds live, and saves the space before the export.
- **A refused space is named (#6523).** An export round, the ordinary one and the snapshot catch-up offer, reports the spaces it skipped as `sync:export_refused`, and an empty list once on the first round that skips none (`export_refusal_report`). `useSyncExportRefused` keeps them in the sync store; the Sync & devices card and Settings › App health show one warning.
- **A forked device says why (#6523).** A catch-up snapshot that forks this device's own `(peer, counter)` space is recognised (`snapshot_transfer::is_own_history_fork`) and reported as `SyncErrorCode::OwnHistoryFork` under a constant text. The frontend words the cause and the recovery.

## Decisions and traps

- **SQL is not always the truth.** The issue calls the repair mechanical because "SQL holds the tombstone the engine lacks". That holds when a delete missed the engine. It is false when an import reached the engine and not SQL: the engine then holds a peer's restore, and mirroring SQL would trash the block again on every device. An import writes its inbox row before it touches the engine, so a row is the signal. The reviewer added the case this missed: boot replay moves a row it gives up on to quarantine without projecting it.
- **The round's soft-deleted set is stale by design** (read once, before the per-space loop). The gate still triggers on it; the decision to write is taken on a fresh read under the lock, and the mirror's own verdict decides the export, not a second look at the stale set.
- **The mirror's ops are in no op log.** Exported unsaved, then lost in a crash, their ids would be minted again by the next edit, which the peer would drop as already held. Hence the save before the export.
- **The fork's error text carries the device's op counter**, which moves with every edit, and the text is the once-per-streak suppression key. The booked text is a constant for that reason.
- **A fourth `listen()` in `useSyncEvents` would have edited 51 assertions** that wait on "three listeners". The event has its own hook, as `sync:network_blocked` has.
- **`docs/TROUBLESHOOTING.md` is the local-dev doc**, so the user-facing recovery went to `docs/features/sync.md` § Pitfalls instead of there.
- **The fork guard fires without any new edit**: it needs only an own-peer counter above zero and a peer holding more. The docs first said "once it is edited"; the code says otherwise.

## Left open

- A block a peer restored while this device deleted its ancestor is live in the engine and deleted in SQL by design (the resurrection guard in `reproject_block_deleted_at_from_engine`), with no inbox row. The mirror tombstones it. Before this change both devices stopped exporting that space for good. Recorded on #6565.
- Test helpers across the suite `.expect()` that the gate does not refuse. That was a free engine/SQL parity check and is now weaker: the gate repairs instead. `undo_of_create_does_not_trip_1257_freshness_gate_2655` lost its export half for that reason and keeps its direct engine read.
- No e2e spec. `useSyncEvents` and `useSyncExportRefused` listen only under Tauri, so the mock lane cannot show either message, and neither state can be produced from outside a real backend: the repair heals the first, and the second needs a database restored under a running pair.

## Verified

- Red first, on the predicted assertion: every new Rust and vitest test. Each of the repair's guards (fresh read, inbox, quarantine, write lock, still-live filter, save) was removed alone and its test went red; so were the catch-up's report call and the fork's constant text.
- On the branch merged with `main`: `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace` in two halves (4004 and 3998 passed), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `just gen-sqlx` with no diff, `npm run typecheck`, `prek run --hook-stage manual --all-files`.
- Before the merge and the review fixes: full vitest (26676 passed) and `npm run lint`. After them: the touched vitest files only.
- An independent read-only review of the repair by a second model; its three concrete findings are fixed in the PR.
- `just e2e-related` selects both whole lanes (`src/App.tsx` changed), so CI's runs are the e2e check.
- The first full nextest build died of a full disk: `target/debug/incremental` held 14 GB. `CARGO_INCREMENTAL=0` for whole-workspace runs, as `docs/BUILD.md` says.
