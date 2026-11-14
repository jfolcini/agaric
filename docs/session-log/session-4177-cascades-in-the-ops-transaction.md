# Session 4177 — window 5: a delete's, restore's or purge's cascade is written in the op's transaction

`Refs #6521`. Option 1 of the stage B comment: the engine half of a cascade moves into the transaction of the op that caused it. Since #6777 boot builds each engine from its saved rows and replays no op, so a kill between an op's commit and its cascade lost the cascade for good: a restore left SQL live and the engine deleted, and peers never saw it; a purge left the blocks in the engine.

## The paths that had the gap

Every one wrote its cascade through `saving_fan_out`, a transaction of its own after the op's commit.

1. **The materializer's single-op apply** (`apply_op_with_mode`: `ApplyOp` for draft recovery and the retry queue, `ReplayApplyOp`): a delete's cohort, a restore's cohort and ancestor chain, the cohort a `MoveBlock`'s tail un-swept.
2. **The materializer's batch apply** (`apply_batch`: `BatchApplyOps`, `ReplayApplyOps`): the same three, after the whole batch had committed.
3. **The delete commands.** `delete_block_inner` and what shares `delete_block_in_tx` (the page source save, MCP `batch`, merge-with-previous, the name-collision repair), the content repairs and the boot empty-block sweep: the descendants. `delete_blocks_by_ids_inner`: every engine write.
4. **The restore commands** (`restore_block_inner`, `restore_blocks_by_ids_inner`, `restore_all_deleted_inner`): every engine write.
5. **The purge commands** (`purge_block_inner`, `purge_blocks_by_ids_inner`, `purge_all_deleted_inner`): every engine write.

Undo and redo already wrote their cascade in their transaction (`drive_reverse_engine`). A sync import applies no op: it projects engine state, and a peer's cascade arrives as that state.

## What shipped

- **The kernel writes the cascade.** `apply_op_tx_with_mode` calls `dispatch_cohorts` after the op's projection, so paths 1 and 2 and every delete that routes through `apply_op_projected` get it with no caller involved. The fan-out helpers lost their pool and their transaction: `engine_apply` records into the rollback log the caller's transaction armed, so the op's `loro_doc_delta` row holds the cascade and a rollback rewinds it.
- **The commands that do not route through the kernel** (batch delete, the three restores, the three purges) call the same helpers before `commit_and_dispatch`. What stays after the commit is derived SQL: the link and FTS repair of the cohort.
- **Removed:** `saving_fan_out`; `engine_apply`'s log parameter (every caller now passes the transaction's); `repair::fan_out_deletes`; `SweptBlock::effects` and `DeleteInTx::op_record`, which only the post-commit fan-out read. `dispatch_deletes` is `remove_deleted_fts`, which is all it still does.
- **`split_after_cascades` is gone.** Boot replay cut a chunk after each delete and restore because an op behind one in the same transaction saw the cohort's old state. It now sees the new one. `delete_then_purge_meters_no_fallback_5418` and `create_after_restore_matches_per_op_oracle_5418` cover this: with the split removed they go red when a batch mirrors its cohorts after its last op.
- **`registry.rs`** imports `AtomicBool` with the sibling atomics (review note on #6777).

`delta::write_engines` keeps one caller: the tombstones a sync import's projection swept (`fan_out_swept_tombstones`). A kill there leaves blocks deleted in SQL and live in the engine, which `mirror_sql_tombstones_onto_engine` repairs before the next export. Moving it into the projection transaction needs a rewind on every failure path after an import the transaction does not own (item C of stage A's notes), so it stays and is on the issue as a decision.

## Tests

`tests/commands/engine_delta_tests.rs`, twelve new, each red on the unfixed code. The fault is a trigger on `loro_doc_delta` that lets a set number of further rows in.

- One more row allowed, where the op's own transaction already wrote the engine: `delete_block_inner`, and a delete then a restore the materializer applies alone and as a batch. Red was the oracle (`settle`): the cascade's row was refused and the engine held writes no row did.
- No row allowed, where the cascade is the transaction's only engine write: the batch delete, each restore, each purge, and a `MoveBlock` out of a deleted parent applied alone and as a batch. Red was the command returning `Ok` with its op committed. Green asserts the op is not in the log and SQL and the engine are as they were.

## Cost of the largest cohort

The cascade's engine writes were already made under the write lock, in the transaction after the op's. They are now in the op's, so the total is unchanged and the longest single hold grows by them. `durability_cost_tests` has a new case, the cascade of a delete over every block of a space through `dispatch_delete_descendants`, each sample on a newly rehydrated engine. One release run in this session's container (4 cores, load about 1), median and range of 5:

| Cohort | Engine writes | Delta and commit | Row |
|---|---|---|---|
| 10,000 blocks | 91 to 112 ms [83 to 114] | 5.8 to 5.9 ms [4.3 to 6.9] | 100 KB |
| 100,000 blocks | 945 to 1014 ms [881 to 1170] | 39 to 44 ms [39 to 56] | 1.04 MB |

Each cell spans the two seedings the harness runs (no edits, and ten edits a block). That is about 10 µs a block. The write pool's `busy_timeout` is 5 s, and the SQL half of the same cascade was in the op's transaction before; it is not in this harness.

## Suites run

The whole-workspace nextest in two partitions, doc-tests, `cargo clippy --workspace --all-targets -- -D warnings` and `prek run --hook-stage manual --all-files`, on the branch merged with `origin/main`. No SQL changed, so no `gen-sqlx`. The reworded doc comment on `StatusInfo::descendant_fanout_dropped` is in `bindings.ts`, so the bindings were regenerated: the drift test caught it. The real-backend e2e lane was left to CI: `just e2e-related` selects the whole lane for this range.
