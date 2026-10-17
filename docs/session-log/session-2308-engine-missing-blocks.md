# Session 2308 — Live blocks an engine lost come back; the replay that lost one is pinned

#5670: #5628's integrity check, run on a copy of the maintainer's vault,
found one live block in Work that Work's Loro engine did not hold.

**Diagnosis** (posted on #5670). Every op was local. On 0.13.0 the local path
did not advance the apply cursor, so each boot replayed the previous session
onto an engine that already held it. A boot on 2026-09-16 replayed an indent,
which moved the block under C90, already deleted in the engine. Replay's
sweep then tombstoned it. Its outdent, replayed next, found no space and took
the SQL-only fallback, which un-swept SQL but never moved the engine node.
Purging C90 on 10-08 removed the block from the engine with it. #5630 (replay
routing and no sweep during replay) and #5418 (the snapshot pass advances the
cursor) fixed the cause.

**Regression test.**
`replay_over_an_engine_ahead_of_the_cursor_keeps_an_outdented_block_through_the_purge_5670`
replays the vault's sequence onto an engine ahead of the cursor, purges the
old parent, and checks that the block is live under its SQL parent and that
the engine and SQL trees match. It goes red only with both halves of #5630
reverted; routing alone stays green, because the sweep is what tombstoned the
block.

**Repair.** `repair.engine_missing_live_blocks.v1` runs once at boot. It finds
live blocks their space's engine lacks and re-seeds their page groups with
the existing hydration walker. It writes no ops, because the op log already
holds them, the same as #4775's hydration; `commands/AGENTS.md` now says so in
one sentence. The marker is written only after the engines are saved, since
nothing would replay a lost repair. On the vault copy it hydrated the one
block in about 126 ms, left zero divergences, and a second run took 0.3 ms.

**Review found one defect.** Siblings seeded at space assignment ranked by a
legacy position stamp that later moves never refresh. So a restored block
could land between siblings in a stale order, and the follow-up position
pass would write that order to SQL. `ranked_slot` now ranks by SQL first and
uses the stamp only for siblings SQL does not hold. A test reorders siblings
before the loss and reds with the old precedence. Review also pinned the
marker-after-save order with a test that reds when the marker is written
first.

**Accepted risk.** A peer that moved the purged node before merging the
purge could revive a second live node. The maintainer's only peer last
synced before this block existed.

Gates: the targeted nextest (367), clippy, `SQLX_OFFLINE=true cargo check`,
fmt, and the full workspace suite. Partition 2/2 passed 3,490 of 3,490;
partition 1/2 passed 3,498, with one unrelated proptest
(`reverse_proptest_b1`) timing out under a loaded box and passing alone in
26 s. That test goes on the slow-test list.
