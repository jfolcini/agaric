# Session 4180 — Writers take turns at the write lock

The first of two maintainer decisions left open by #6766 (#6567): a fair queue for the writer, by a gate in `begin_immediate_logged`. The second, SQLite's busy code as `pool_busy`, is session 4179 (#6784).

Session 4179 called this one session 4178. That was the number assigned to it; 4179 merged first and put 4178 below the numbering guard's floor, so this log is 4180.

## What was wrong

The write pool has two connections and SQLite gives its write lock to whichever of them polls first. A writer waiting on the lock sleeps between polls, up to 100 ms at a time, so a writer that begins again the moment it commits, or one that takes the connection a commit just freed, gets there first every time. The waiting writer gave up at the 5 s busy timeout. #6766 saw the background consumer starved this way by back-to-back batch commands.

## What shipped

- **`begin_immediate_logged` queues.** It waits for a turn on a fair async mutex before it takes a connection, and returns a `WriteTx`: the transaction and the turn. The turn ends when the transaction commits, rolls back or is dropped. There is one queue per database file (`write_turns`), found from the pool's connect options, so the function's arguments did not change and a second pool on the same file waits in the same line.
- **`WriteTx` derefs to `sqlx::Transaction`**, as `CommandTx` does. `&mut tx` still passes to every `*_in_tx` helper; an executor use is `&mut **tx` where it was `&mut *tx`. That, and the type's name where a transaction is stored or passed by value (`CommandTx`, `commit_with_deltas`, the sync projection's begin and commit), are the whole caller diff.
- **Five production transactions that opened with `pool.begin_with("BEGIN IMMEDIATE")` now open through the helper:** the three `peer_refs` stamps at the end of a sync session (`session_state_machine.rs`), the catch-up stamp (`snapshot_transfer.rs`) and the boot draft write-back (`draft_recovery.rs`). So does the test-only `append_local_op_at`.

## The trace

**Write transactions not opened through the helper.** Besides the six above, the four boot recoveries in `src/db/recovery.rs` open a deferred `pool.begin()` and write. They run inside `init_pools`, before the pool is handed to anything else, so there is no other writer to queue behind. Left as they are. Every other `pool.begin()` in production only reads.

**Single statements run on the pool outside a transaction are not in the queue.** There are many, across all four crates. The ones on a hot path: `save_draft` (typing autosave), the materializer retry queue's rows, the FTS removals, `derivations::record`, the `SetBlockPageId` space stamp, `record_page_open`, the MCP `stamp_last_used`, and the apply-cursor advance. Each holds the lock for one statement and takes it by polling, as before, so a run of queued writers handing the lock to each other can still starve one of them to the busy timeout. Left, and reported in the PR as a decision.

**Holding one write transaction while starting another.** None found, in production or tests, in any of: the same task nesting a second begin; a transaction held across a materializer flush or settle, a blocking queue send or a joined task; an async lock taken in both orders. Things that depend on how the queue is built, and hold:

- The turn is taken before the connection. The history commands read on the pool's second connection while they hold their transaction; a queued writer holding that connection would have made the read wait out the pool's acquire timeout.
- `CommandTx::begin_immediate` can fail its space guard after the transaction opened. The turn goes with the dropped transaction; `space_guard_refuses_inside_the_write_transaction_5402` opens a second `CommandTx` straight after the refusal and would hang otherwise.
- `save_all_engines` holds its own process-wide mutex across its write transaction; no caller holds a write transaction when it calls in.

## Traps

- The wait for a turn has no timeout. A nesting the trace missed would hang where it used to fail busy after 5 s. A bound on the wait was left out on purpose: `tokio::time::timeout` under a paused test clock fires as soon as the holder is waiting on SQLite's thread.
- A dropped `sqlx::Transaction` rolls back on SQLite's worker thread, after the drop returns. The next writer's `BEGIN IMMEDIATE` can find the lock still held for a moment and polls for it.
- Tests that hold the lock so a contender fails busy take it with `pool.begin_with`, outside the queue. One that held it through the helper would make its contender wait instead.

## Edited test values

`derivations::tests::GOLDEN` hashes the source of each derivation rule. The `&mut **tx` rewrite changed the hashed text of `PageLink` and none of its output, so its golden hash is new and its version is not, as that test's message directs: no vault rebuilds for it.

## Suites run

`cargo nextest run --workspace` in two halves, `cargo test --doc --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, and `scripts/check-raw-tx.mjs` over the tree. Both new tests were shown red by one mutation, the helper taking its turn from a fresh mutex: the order test served `[1, 2, 3, 4, 5, 0]`, and the starved writer was refused with SQLite's busy code at the test's 200 ms busy timeout.
