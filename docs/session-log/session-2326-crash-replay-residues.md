# Session 2326 — Crash replay reaches the engine for restore, purge, space move and retries

#5647 listed four ways a crash-recovery replay still missed the Loro engine
after #5630. A read-only plan pass confirmed all four on main. It corrected
the issue's steps for the purge case and widened the space-move case. The
maintainer approved the one persisted-format change in case 4.

1. **Restore.** SQL already holds the restore, so the cohort query comes back
   empty. On replay with an empty cohort, the descendants (matching
   `deleted_at`) and the ancestors are now read from the engine.
   `ApplyEffects::restore_space_id` keeps the fan-out on the right engine
   when a later op in the tail re-deleted the seed.
2. **Purge.** SQL no longer has the row, so its space did not resolve. On
   replay the block is purged from every engine that holds it, found by the
   new `LoroEngineRegistry::spaces_containing`.
3. **Space move.** SQL already shows the new space. Replay takes the new space
   from `resolve_op_space` and the old doc from the registry. Hydration also
   admits rows deleted at or after the move. Without this, the old doc kept
   the subtree even when nothing deleted the page later.
4. **A retried replay op** ran as an ordinary op and lost replay routing. Its
   retry row is now `ReplayApplyOp:<seq>:<device>`, a new persisted
   spelling; the old `ApplyOp:` spelling is still read. It runs as
   `ApplyMode::ReplayRouted`. Recording a failure or a success retires the
   other spelling for the same op.

Every fix is gated on replay; live commands are unchanged. Each case's test
went red first, including both variants of restore and of space move.
Comments that said replay rebuilds the engine from scratch, or that the
purge fallback is unreachable, are corrected.

**Review** (a second model) found that `record_failure` retired the other
spelling before inserting its own, as two statements. The retry row is the
only record of an op that never applied (the apply cursor is `MAX`), so a
kill between them, or a refused insert, lost the write. It now inserts
first, and a test reds on the old order.

**Rebase over #5700.** Both changed the shared hydration call: #5700 added
`rank: SeedRank` and this change `admit_deleted_since`. The function takes
both, and #5670's repair passes `None` (live rows only). The recovery tests
file was rebuilt as main's version plus this change's tests.

**Accepted.** Hydration's `deleted_at >= created_at` admission can seed a
ghost row after a backward clock step that coincides with a crash. Review
judged that acceptable under the threat model.

Gates: the full workspace suite in four partitions (6,992, review), the
affected tests after the rebase (325), clippy, `SQLX_OFFLINE=true cargo
check`, and fmt.
