# Session 4076 — four items the maintainer decided on 2026-11-13

One PR, one commit per item, for decisions the maintainer took on questions earlier sessions had left on #6523, #6554, #6535 and #6629.

## What shipped

- **#6523, "Last synced" after a restart.** The sync store's `lastSyncedAt` was written only by a session's `sync:complete`, so the sidebar tooltip read *Never synced* and the Sync & devices card `--` after every launch. Nothing new is stored: `peer_refs` already keeps `synced_at` and `streamed_at`, and `mapPeerRefToInfo` already turns their later one into each peer's `lastSyncedAt`. `setPeers` now folds the latest of those into the store's own time when it is later. The fold is in the store, not a selector, because `StatusPanel.test.tsx` mocks `@/stores/sync` whole and a second export would have had to be mocked beside it.
- **#6554, the daily snapshot.** `take_daily_snapshot` reads the free space of the vault's folder (`fs4::available_space`) and skips the day, with a warning in the log, when it is less than the database file. A free-space figure that cannot be read does not cost the day its snapshot. `MAX_KEPT_DAILY_SNAPSHOTS` is three on Android and seven elsewhere.
- **#6629, the design note.** `docs/architecture/pdf-annotations.md`, linked from the architecture index. It records the decisions from the issue's comments with their reasons and names the symbol that holds each; it carries no figures.

## Not built

- **#6535, the agent badge.** Already on `main` from #6679; the issue is closed. Said so on the issue.

## Traps

- **`fs4` re-pointed an unrelated lock edge.** Adding it made cargo move `quinn-udp`'s `windows-sys` from one locked version to another in both `src-tauri/Cargo.lock` and `src-tauri/fuzz/Cargo.lock`. Both edges were put back by hand and `cargo metadata --locked` accepts the result, so the lock diff is `fs4` alone. `rustix` and `windows-sys`, its only dependencies, were already locked.
- **Nothing already in the lock reads free space without `unsafe` on every platform.** `rustix` has `statvfs` for Unix only; Windows would have needed a `windows-sys` call, and `unsafe_code` is denied.
- **A commit stashes unstaged work while its hooks run.** The first commit was made while a cargo build of other, unstaged files was in flight, and prek's stash took those files out from under it. Commit only with no build running, or with nothing unstaged.
- **The first cold build outran a ten-minute tool timeout** and was killed part way; a cold `cargo nextest` build goes in the background with a long limit.
- **`just gen-bindings` left a diff that was not this branch's.** Two PRs had crossed on `main`; #6707 regenerated the file there, so the local regeneration was discarded and `main` merged in.

## What could not be shown

- **The restart spec in `e2e-tauri/sync-two-device.e2e.ts` was not run locally**, red or green: this container has no `tauri-driver`. It freezes the peer, restarts the app and reads the state card's last-synced time, which no session of the new launch can have written. The store tests were seen red on `expected null to be '2025-01-16T00:00:00.000Z'` before the fix.
- **The Android snapshot count runs in no test**: the suite does not build for Android.

## Suites run

Before the merge of `main`: `cargo nextest run --workspace` in two halves (4037 passed; 4030 passed and 1 failed, `ts_bindings_up_to_date`, a drift on `main` that #6707 fixed), `just gen-sqlx` (no diff), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo audit` and `cargo deny check`. After the merge: `ts_bindings_up_to_date` and the snapshot tests again, `cargo test --doc -p agaric`, full vitest (1111 files, 26892 passed), `npm run typecheck`, `npm run lint`, `prek run --hook-stage manual --all-files`, and three sync Playwright specs (11 passed). `e2e-related` selects both whole e2e lanes, which were left to CI.
