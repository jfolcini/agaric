# Session 4131 — A commit's background tasks take one queue slot; a busy writer is waited out; a settle runs what the queue shed

Set out to reproduce and fix what the #6724 session found and left: after one `create_blocks_batch` of 1,000 blocks and a `set_property_batch` over them, the settled integrity check reported blocks with no `fts_blocks` row and no `agenda_cache` rows.

## What was wrong

`CommandTx::commit_and_dispatch` enqueued each op's background tasks one at a time with a send that does not block. A content create is four tasks, so a batch at its cap offers the 1024-slot channel several times its capacity before the consumer has run, and the surplus was shed. Three things followed:

- **The shed tasks waited for the sweeper.** A shed task goes to `materializer_retry_queue` with a first backoff of a minute, and the sweeper ticks once a minute. A global rebuild shed once per op escalated its own row: 1,000 `RebuildAgendaCache` sheds are one row at the shed ladder's five-minute cap.
- **`flush_background` returned at its barrier** with those rows still waiting, so the integrity check, the tests' `settle` and the `after_rebuild` event of #6724 all read a vault that had not settled.
- **Each shed spawned its own retry-row write** on the two-connection write pool.

A second cause showed only once the first was fixed: under batch commands sent back to back the background consumer itself waits out the 5 s busy timeout (SQLite's busy handler polls, it is not a queue, and a writer that begins again at once wins every time). After three attempts the task was counted failed and sent to the retry queue on the failure ladder.

## What shipped

- `Materializer::dispatch_commit`: a commit of one op enqueues as before; a commit of several sends one `MaterializeTask::CommitFanOut`, which the consumer unpacks into its drain before the dedup. A shed commit is deduped and persisted by one spawned writer.
- The background consumer runs its retry schedule again while it ends on write contention (`AppError::is_write_contention`, moved from `maintenance.rs`).
- `Materializer::settle_background`: a flush, then every shed-marked retry row again as one `CommitFanOut` on a blocking send, then a flush. The integrity check, the `after_rebuild` event and the tests' `settle` call it. `flush_background` stays a barrier.
- `dedup_tasks`: a `RemoveFtsBlock` lets a later `UpdateFtsBlock` of the same block through. Keep-first dropped the restore's update of a block deleted and restored in one commit (a point-in-time restore), and the removal deletes the row whatever the block's state. A commit landing in one drain used to be likely; it is now certain.

## Traps

- The first version put the shed re-run inside `flush_background`. The reviewer found its other callers: quit and boot flush on the main thread, the snapshot pass flushes under its mutex, and a pull flushes inside its message budget. None of them promises a settled vault, so the re-run moved to its own method.
- With only the first fix reverted the scenario tests still find every row, because the tests' settle now runs the shed tasks; they fail on the shed counter alone. A test of the queue has to read `bg_dropped`, not just the derived rows.
- The test fixture's space block is a raw insert with no index row, so an integrity report in a test is never empty: compare with a baseline report.
- The measurement harness (`measure_dated_batches_back_to_back`, `#[ignore]`) is not a gate: which writer wins the lock is poll timing. Its settle time scales with the work (two batches, five batches), so the five seconds it prints at five batches is not a busy timeout.
- `database is locked` on a command did not reproduce in the Rust lane at ten batches of 200. What the harness shows is direction: a single create issued while the queue drains waited an order of magnitude longer before the fix.
- A whole-workspace test build filled the disk mid-link (`No space left on device` on `libagaric_lib.rlib`); `rm -rf src-tauri/target/debug/incremental` and `CARGO_INCREMENTAL=0` as `docs/BUILD.md` says.

## Not fixed

- Boot replay's `fan_out_replayed_ops` still dispatches per op, so a replay of a few hundred ops after a kill sheds the same way and heals at the sweeper's pace.
- A task with no retry kind (`RemoveFtsBlock`, `ReindexFtsReferences`) that is shed leaves no row, as before, and no settle runs it.
- A command that waits out the busy timeout gets `SQLITE_BUSY` as a `database` error, which the frontend's `retryOnPoolBusy` does not retry; `docs/architecture/operations.md` describes it as `pool_busy`.
- The two write connections still take the lock by polling. A fair queue (a write pool of one, or a gate in `begin_immediate_logged`) is a design call.

## Suites run

`cargo nextest run --workspace` in two halves on the final code (4,051 of 4,052 and 4,044 of 4,044 passed; the one red is a random property test in `agaric-store`, `incremental_fts_writers_leave_what_a_rebuild_produces`, red about one run in twelve on unchanged code and reported in the PR), doc-tests, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, `just gen-sqlx`, `just gen-bindings`, the manual-stage hooks. Each new test was shown red by one mutation. An independent reviewer read the diff before the gates. Not run: vitest, typecheck, lint, Playwright, WebdriverIO; nothing they read changed.

PR: the one on `claude/background-queue-overflow-large-batch`.
