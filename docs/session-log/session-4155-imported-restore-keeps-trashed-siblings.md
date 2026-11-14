# Session 4155 — An imported restore un-deleted blocks the restoring device kept in its Trash

Set out to test the three paths session 4150 read as clearing `deleted_at` without a link reindex, and to fix any that was real with the cohort link reindex. One was real, and the missing link rows were a symptom: the block should not have come back at all.

## Sync-imported restore: real, fixed at the cause

Device A trashes block D, then D's parent X, which takes X's other child Y along. A restores D. The local restore brings X back as D's ancestor and leaves the rest of X's cohort, Y, in the Trash. Device B, which imported the two deletes before the restore, imports X's cleared delete mark and clears X's whole cohort in SQL (`reproject_block_deleted_at_from_engine`, the restore arm). Y's own mark did not change, so Y is not in the import's changed set and gets neither the pass's re-stamp nor the per-block link and FTS tasks. On B, Y was live with no `block_links` and no `fts_blocks` row, while A had it in the Trash and B's own doc still marked it deleted. No concurrency is needed, only the two syncs in that order.

The fix is in the import's soft-delete pass (`project_pass_c`): the restore arm now returns the cohort it cleared, and the pass re-reads each member's own mark from the doc and re-projects the ones that carry one. Y stays in B's Trash, as on A. The recovery reprojection visits every block, so by reading it already left Y there. A member with no mark of its own stays restored, as before.

No link reindex was added for the members that do stay restored. They come back with the rows they had: an import drops a block's rows only when that block's own doc state changed while it was trashed, and no route was found that does that and then restores it without its mark changing.

The first scenario tried was the one session 4150 guessed: B moves a block under X while A, unaware, trashes and restores X. It does not fail. In the run, every import from A reported that block as changed while A had not seen B's move, so the pass re-stamped it from its own mark.

## MoveBlock un-sweep: no production route

`unsweep_inherited_cohort_after_move` clears rows only for a move whose subject carries an inherited tombstone. Nothing in production applies such a move:

- a foreign device's ops are audit rows, never applied; sync arrives as a doc import. `Materializer::dispatch_op` and `MaterializeTask::BatchApplyOps` have no caller outside tests;
- every local `MoveBlock` author checks the subject is live: `move_block_inner`, the undo path (`reparent_active_block`), and the orphan and journal-duplicate repairs select live blocks only;
- boot replay re-applies local moves through the engine arm, which un-sweeps nothing. Its SQL-only fallback (a block with no space or absent from its engine) can un-sweep, but only for a block a later op in the same replay trashes again: local moves are written on live blocks, so a tombstone met at replay comes from a delete further down the log.

No code, no test.

## Recovery reprojection: nothing specific to the cleared tombstones

`reproject_blocks_from_engine` runs when the `blocks` table was rebuilt from nothing, or to retry such a boot. It then rebuilds `fts_blocks` in full, from page titles and not through `block_links`. `db/recovery.rs` does not touch `block_links`; the vault-wide derive is `backfill_block_links` at boot, gated by a marker. So after a rebuild every block lacks its link rows until that pass runs, restored or not, and a vault whose marker is already set gets none. That needs the `blocks` table to vanish on a current vault. The cause the code names is a table rebuild cut short in migrations 0073 to 0089, all older than the marker. Left alone; if it is wanted, `rederive_block_links` in `rebuild_caches_after_engine_reproject` is the place.

## Comments

Three comments said the edit projection filters `deleted_at IS NULL`. `project_edit_block_to_sql` is unguarded on purpose (#2909); they now say so.

## Suites run

`cargo nextest run --workspace` and `cargo clippy --workspace --all-targets -- -D warnings`. The new test was red before the fix on its last assertion: Y live on B, trashed on A.
