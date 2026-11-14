# Session 4125 — Review notes from the PRs merged on 2026-11-13 and 14

One follow-up PR for the non-blocking notes the reviewer left on #6710, #6713, #6715 to #6725, #6728, #6730 and #6732. Most of them earned no change; each is listed with the reason.

## What shipped

- **#6724, the property event's second sending.** `registerPropertyChangeTarget` takes `readsRebuiltViews`, and the dispatcher hands an `after_rebuild` payload only to targets that passed it. One does: the global counter, whose consumers read `agenda_cache` and FTS. The scoped counter behind each `BlockTree`'s batch properties, `usePageProperties` and the key and value caches read primary state, which the command committed before the first sending. The reviewer's note said only `useBatchCounts` needed the repeat; every agenda and search consumer of the global counter has the same race, so the cut is by target, not by consumer. The test was red on `expected 1 to be +0` (the scoped counter) before the change, and on `expected +0 to be 1` (the global counter) with the flag dropped.
- **#6715.** `rejects_the_dropped_app_link_shape_6555` and the vitest `routes no https URL` are deleted: with the https arm gone each repeats the wrong-scheme test beside it.
- **#6732, CodeQL alerts 296 to 298.** The assertion messages of `create_blocks_batch_refused_client_id_rolls_back_6559` name the case, not the block id.

## Shown red: #6710's restart spec

Session 4076 could not run `after a restart the state card shows the last sync before any new one` (`e2e-tauri/sync-two-device.e2e.ts`). Run here with `just e2e-real`, in a worktree, with `setPeers` reduced to `set({ peers })`: it failed on `the state card shows no last sync after the restart: "--"`. The same spec on unbroken `main` passes that test.

`Settings shows this device's sync address` fails in both runs in this container (`local-sync-address` never shows), so it is the container's network and not the break. CI is its check.

The container needed `apt-get install webkit2gtk-driver openbox xdotool` and `cargo install tauri-driver --locked`; with those the lane runs here.

## Notes that earned no change

- **#6710, a large `-wal` and the free-space check.** The reviewer called it fine to leave: autocheckpoint bounds the WAL, and a copy that runs out of room is removed and logged by the tick.
- **#6713, delete the Flathub draft.** No failure named. The file says DO NOT SUBMIT in its first line, `lib.rs` and the README are written around it, and whether to go on with Flathub is the maintainer's decision on #6660.
- **#6716, drop `SCOPE`'s export.** No longer true: `page-mode-text.spec.ts` (#6719) imports it.
- **#6719, import `SEED_IDS`.** The premise is wrong: no spec under `e2e/` imports from `src/`; the ones the note cites name `SEED_IDS` in a comment and declare the ids, as these two do. A seed that moves an id reddens the spec.
- **#6721, `save_to_downloads` returns the final name.** Skipped, not judged: the name has to travel through `saveBlob` and its callers, `ExportSection.tsx` among them, which #6726 rewrites.
- **#6722, delete `durability_cost_tests.rs`.** Left. Nothing on `claude/6521-stage-a-delta-per-write` uses it (that branch brings its own `delta_cost_tests.rs`), but removing it edits `loro/mod.rs`, which that branch also edits, and `claude/6521-windows-4-6-2` is not pushed, so it could not be checked.
- **#6724, `flush_background` fires the #2935 debounce early.** Skipped: the fix is a barrier of its own in the materializer's background queue, which another session is changing. The reviewer: extra work, not a wrong result.
- **#6724, CodeQL alert 295.** Already gone: the test reads the file with `readFileSync`.
- **#6728, a sentence in session 4112's log.** A merged log is not edited. The sentence "the script now stops on a failed build" there describes no change in the repository: `scripts/e2e-tauri-local.sh` already had `set -euo pipefail`.
- **#6730, one helper for the HTML-to-Document conversion, and the plain-paste chord.** Neither names a failure; the reviewer says of the second that nothing goes wrong today.
- **#6732, `removeBatch` and an already-deleted block.** `delete_blocks_by_ids` does not say which ids it skipped, so the exact state needs a new response field, and the block's real `deleted_at` stays unknown either way. The reviewer: harmless.

#6717, #6718, #6720, #6723 and #6725 carried no note.

## Suites run

`npx vitest run` over `src/lib/__tests__` and the touched hook tests (148 files, 4691 passed), `npm run typecheck`, `npm run lint`, `cargo nextest run --workspace` filtered to the three touched or neighbouring Rust tests (3 passed), `cargo clippy --workspace --all-targets -- -D warnings`, and the two `just e2e-real` runs above. The full suites and both e2e lanes are left to CI.
