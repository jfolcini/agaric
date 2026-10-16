# Session 2222 — Crash replay carries a later-deleted block's ops to the engine (#5630)

Boot replay resolved each op's space with `resolve_block_space`, which skips
tombstones. SQL already holds the replayed tail, so in it a delete, and any
edit, property, tag, alias, move or create on a block that a later op
deletes, found no space and took the SQL-only path. The engine never got
those ops, and a page deleted in the tail stayed live there.

**What changed:**

- **The resolver.** On replay only, `resolve_op_space` falls back to the
  soft-deleted resolver, so those ops reach the engine. The edit, property,
  tag and alias helpers and `resolve_doc_space` take a `replay` flag; move
  and create read `replay_dirty`.
- **The delete.** `apply_delete_block_op` normally captures its cascade
  before its `UPDATE`. On replay over SQL that already holds the delete, it
  rebuilds the cascade from the rows stamped with the delete's timestamp
  (`collect_cohort_deleted_at`, split out of `collect_restore_cohort`), so
  the post-commit fan-out writes the engine.
- **No sweep on replay.** Review found a tail that came out wrong. W moved
  into P, then out to Q, then P was deleted. The replayed move into P saw
  P's later tombstone and swept W into it. The move out ran the engine arm,
  which never un-sweeps, so W ended trashed in SQL and the engine. On replay
  the engine arm no longer sweeps; the later delete's own replay stamps W if
  W is still under it.

  Every local move producer checks that the target parent is live, so a
  local move lands under a tombstoned ancestor only in a damaged vault. A
  probe of that case gave the same result with and without the skip.

**Tests** (`agaric-sync/src/recovery/tests.rs`):

- `crash_after_a_snapshot_pass_replays_only_the_tail_5418`;
- `crash_tail_ops_on_blocks_deleted_later_reach_the_engine_5630`;
- `crash_tail_move_in_move_out_then_delete_the_old_parent_5630`, review's
  case. It was red on the first commit ("W is live in SQL, as in the
  session") and red again with the skip reverted.

**Comments corrected:** the move-routing claims in `loro_apply.rs`,
`projection.rs` and `sql_only.rs`; the delete cohort's "unrecoverable
afterwards" and "captured before the UPDATE" in `kernel.rs`;
`op_log_head`'s list of boot-only engine writers; and the `SpaceUnresolved`
text in `sql_only_fallback.rs` and `sql-only-convergence.md`.

**Not done** (#5647):

- A restore, a purge, a page's space move or a retried op in the tail still
  misses the engine.
- In a damaged vault, replay does not put a live sweep's tombstone back
  into the engine. This predates the change.
- The SQL-only move arm still reads later tombstones on replay. It writes no
  engine state.

**Suites:** focused nextest over recovery, replay, move convergence and
history; the full workspace in two partitions; clippy, `SQLX_OFFLINE` check
and fmt.
