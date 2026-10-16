# Session 2214 — Pages the backfill places in Personal reach its engine

A review of #5631 (#5418 step 2) after it merged found a regression. The
review used a scratch repro and compared the cursor-advancing pass against
the old one.

**The bug.** The space-less page backfill (`backfill_space_less_in_tx`, on
every boot and after every inbound sync) appended a `SetProperty(space)` op
per page. It wrote `blocks.space_id` with a chunked UPDATE and never touched
the Loro engine. Before #5631 the next boot's replay was what hydrated those
pages into Personal's doc. Once any snapshot pass may advance the cursor,
even a quiescent one, those ops are skipped, and the pages stay out of the
engine. From then on they don't sync through the CRDT, a reprojection from
the engine loses them, and every edit takes the SQL-only fallback. #4743 had
fixed the same shape for tags; the page migrator was left behind.

**The fix.** `migrate_pages_to_personal_space` (no longer batched) applies
each record through `apply_op_projected` in the same transaction, as the tag
migrator does. Both callers arm the engine rollback, so a failed commit
leaves no half-hydrated engine. The chunked UPDATE is gone.

One cost: hydration is quadratic in page count, because each page's hydrate
reprojects Personal's top-level page list. The review measured a legacy first
boot with three children per page, release-test profile:

| Pages | Bootstrap now | Bootstrap before | Next-boot replay before |
|---|---|---|---|
| 1,000 | 3.3 s | 0.07 s | 2.0 s |
| 2,000 | 7.4 s | 0.11 s | 9.4 s |
| 4,000 | 38.7 s | 0.21 s | 34.2 s |

The work moved from the second boot to the first rather than grew. Three
things did change with it:

- **One transaction.** Replay committed in chunks and resumed after a
  force-quit; the bootstrap is one `BEGIN IMMEDIATE`, so a user who kills
  the frozen first boot starts over.
- **Boot-fatal errors.** A hydrate error now fails boot instead of landing
  in the retry queue. No real vault was shown to hold a row that triggers
  one.
- **The writer is held longer.** Mid-session, the sync placement pass holds
  the writer past `busy_timeout` once it places about 1,500 pages. Such
  pages normally arrive inside a space's doc and are stamped from it, so a
  pass that size needs a legacy peer.

All of this falls only on pre-spaces vaults, and was accepted rather than
optimised. Dense reprojection of the root group also renumbers the
`position` of other top-level pages, which nothing orders by.

**The premise, corrected.** #5631 claimed every op below the head is in the
engine. The `op_log_head` doc now lists the engine writes that land after
commit:

- the single-delete cohort;
- batch delete, seed included;
- the three restores;
- the three purges.

Draft recovery, the empty-block sweep and repair also write the engine after
commit, but only at boot, before the periodic pass is spawned. A crash
before the next pass loses the mid-session ones, which is #5630's territory. Every
comment that still said "the cursor stays put so boot replay re-applies"
now says the snapshot pass moves it, in code comments, tests and the
architecture docs. Review found copies the first sweep missed: in `tags.rs`,
the materializer, batch delete and restore, the bulk-equivalence twin,
conformance tests, the crash-injection tests and `rollback-safe-engine-apply.md`.
Those are fixed too.

About 15 "boot replay reconciles" comments on the SQL-only fallback paths
were left alone. They make a separate claim, many were never true even
before #5418, and each needs its own check. #5628's engine-vs-SQL gap is
where that population becomes visible.

**Sweep.** Every production op-log append site was classified. The page
backfill was the only deterministic miss. Attachment ops and the seeded
space blocks never reach an engine by design, before and after #5631.

**Tests:**

- `pages_placed_by_the_backfill_are_in_the_engine_after_a_reboot` failed
  with `[false, true]` on the unfixed code. Two pages are needed because
  boot always replays the newest op.
- `a_failed_boot_backfill_leaves_no_page_in_the_engine` and
  `a_failed_sync_placement_leaves_no_page_in_the_engine` pin the engine
  rollback both callers arm. A blank alias on the third page fails the
  loop. Without the arming, the earlier pages stayed in Personal's engine
  while SQL rolled back, and no existing test noticed.
- The sync placement test now checks Personal's engine as well as SQL, as
  its tag sibling does. The reboot test's pages each have a child, which must
  reach the engine too.
- The test that pinned the deleted chunk path is now
  `bootstrap_appends_one_space_op_per_placed_page`, the one test of one
  `space` op per placed page.
- `quiescent_pass_advances_the_apply_cursor_5418` pins a branch the
  reviewer's mutation run found unpinned. The other branch it named, the
  clean-space watermark refresh, was already pinned by three #3309 tests
  outside the review's filter.
