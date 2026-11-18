# Session 4262 — slow writes on a pulled vault were planner statistics taken while it was empty (#6811)

#6811: on a vault pulled from a peer, or with a peer paired before the writes, a split took about 2 s and a 300-line paste 91 s in the real-backend lane, against 0.3 s and 2 s on a vault the app wrote. The weekly `pulled_vault_bench` had found no gap in the commands or the engine.

Premise check: the same bench run in a dev-profile build gave the same parity (split ratio 0.98 over n=337, paste 0.99 over n=11), so the debug build alone was not the cause.

A new `#[ignore]`d measurement, `pulled_vault_writes` in `src-tauri/tests/command_integration/`, added the rest one ingredient at a time: devices running the sync daemon, a real pairing and pull over loopback, the running materializer, the app's commit hook, the `e2e_sync_peer` binary frozen mid-session or after the pull, and the app's boot with commands sent through the invoke handler. None of these opened a gap. Running `maintenance::pragma_optimize` before the data arrived did, which is what the maintenance daemon's first tick does a minute after a new device boots (5 s under the e2e sandbox).

The cause: `PRAGMA optimize` writes `sqlite_stat1` for `blocks` at the bootstrap's few rows. With those statistics SQLite drives `write_dense_ranks`, the `UPDATE … FROM json_each` that every create and move runs, from a scan of `blocks` instead of a primary-key search. `EXPLAIN QUERY PLAN` after `ANALYZE` scans with 50 or fewer rows and searches from 100 on. Edits and deletes rank nothing, so merges stayed fast. The statistics stay until the job runs again, up to 4 hours later.

Fix: `pragma_optimize` deletes the `sqlite_stat1` rows of any table or index under `MIN_ANALYZED_ROWS` (1,000) and reloads the statistics on the connection that ran it. With no statistics the planner assumes a large table, which is what the queries are written for. A vault that already holds such statistics loses them at its next optimize.

Numbers (debug, one run each, same harness): split on the optimized-while-empty arm 1,362 ms [1,286–1,507] before and 29 ms [20–32] after, against 21–25 ms app-written; the paste and a new vault's first 1,000-block batch went from unfinished after 60 s to 4.2 s and 5.4 s. Full table in `docs/architecture/operations.md` § Loro engine cost.

Not checked: the real-backend lane itself (the WebKit driver is not installed in this container). Connections opened before the dropping optimize keep the old statistics until the app restarts.

## What ran

- `cargo nextest run --workspace -E 'test(pragma_optimize)'`: 3 passed. Three falsifications, each in one command that restored the file on exit. Without the delete, the new-vault test failed on its statistics count (11 against 0). Without the reload, it failed on its plan assertion with the scan plan. With the threshold multiplied by 10, the grown-vault arm failed.
- `cargo test -p agaric --test command_integration pulled_vault_writes -- --ignored --nocapture`, run before the fix (the old `pragma_optimize` swapped in) and after it.
