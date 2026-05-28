## Session 863 — maintenance daemon: tombstone_purge (#157 sub-item E) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (one more sub-item of #157 shipped; H and I remain) |
| **Items modified** | #157 (status comment) |
| **Tests added** | +2 backend (`maintenance::tests` — `tombstone_purge_skips_when_nothing_eligible_157_e`, `tombstone_purge_removes_aged_tombstones_157_e`) |
| **Files touched** | 3 |

**Summary:** Ships #157 sub-item **E** — periodic hard-purge of soft-deleted blocks whose `deleted_at` is older than 90 days (matches the op-log retention window used by sub-item C's `op_log_compact`). One MaintenanceJob entry on the daemon, 24 h cadence, idle predicate; one job-body fn in `maintenance.rs` that picks up to 1000 ids per tick and hands them to the existing `commands::blocks::crud::purge_blocks_by_ids_inner` — the same code path the manual "Empty Trash" UI button drives.

**Why reuse `purge_blocks_by_ids_inner` rather than roll a raw `DELETE FROM blocks WHERE deleted_at < ?cutoff`:** the soft-delete invariant is that `cascade_soft_delete` walks all descendants on user-initiated deletion, so the soft-deleted set is downward-closed. A naive SQL `DELETE` would still need to cascade through ~14 dependent FK-referencing tables in the right order (or use `PRAGMA defer_foreign_keys`), emit `PurgeBlock` ops for sync correctness, clean `page_aliases` / `projected_agenda_cache` / FTS, and dispatch the post-commit cache rebuilds. All of that already lives — battle-tested — inside `purge_blocks_by_ids_inner`. Reusing it costs one extra SELECT (cheap, indexed via `idx_blocks_deleted`) and gets the rest for free.

**Per-tick cap:** 1000 (matches `MAX_BATCH_BLOCK_IDS`). Tombstones that exceed one batch are picked up by subsequent ticks; at 24 h × 1000 / tick the daemon clears 365K accumulated tombstones / year, well past any realistic accumulation rate.

**Conflict note:** This is the third concurrent PR extending the daemon's `jobs` vec at `lib.rs` (alongside the still-open #168 = C+G and #169 = F+J). Whichever lands first cleanly; the others need trivial rebases that simply concatenate the new `MaintenanceJob` literals. There is no semantic interaction between E and any of C/G/F/J — they're independent jobs on the same daemon.

**Files touched (this session):**
- `src-tauri/src/maintenance.rs` (+115 — `TOMBSTONE_RETENTION_DAYS` + `TOMBSTONE_PURGE_BATCH_LIMIT` constants, `tombstone_purge()` body fn, 2 tests covering the early-return path and the happy-path purge)
- `src-tauri/src/lib.rs` (+35 net — extended the `jobs` vec with the `tombstone_purge` MaintenanceJob entry, added the captures `lifecycle_for_tombstone`, `tombstone_write_pool`, `tombstone_device_id`, `tombstone_materializer`)
- `docs/session-log/session-863-…md` (new — this log)

**Verification:**
- `cd src-tauri && cargo check --tests` — clean compile.
- `cd src-tauri && cargo nextest run -p agaric maintenance::` — 6/6 pass.
- pre-commit + pre-push hooks will run on commit/push.

**Process notes:** The maintainer's plan-table cell for sub-item E reads `DELETE FROM blocks WHERE deleted_at < now()-90d`. Shipping a literal `DELETE` would have required either a careful per-table cascade order, `PRAGMA defer_foreign_keys`, AND a synthetic `PurgeBlock` op emission per row for sync correctness — or the cascade would have stranded sync replays on other devices (their `blocks` row stays, their reflexive caches stay stale). The reuse of `purge_blocks_by_ids_inner` (whose behaviour the manual "Empty Trash" button already validates) sidesteps that entire class of bugs.

**Lessons learned (for future sessions):** When a plan-table cell says "do X" and X is a code-pattern that already has a tested inner function, prefer the inner-function reuse over the literal SQL — the maintainer's plan is the intent, not the implementation. The reuse-vs-raw-SQL trade-off should land in favour of reuse unless the existing function has surprising side effects you actively don't want.

**Commit plan:** single commit on branch `feat/maintenance-tombstone-purge-157-E`; PR against `main`. Issue #157 stays open (sub-items H, I remain — H needs midnight scheduling on top of the interval ticker, I needs a dirty-engines counter on top of the loro engine state).
