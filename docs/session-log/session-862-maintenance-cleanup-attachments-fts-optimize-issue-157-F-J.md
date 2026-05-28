## Session 862 — maintenance daemon: cleanup_orphaned_attachments + fts_idle_optimize (#157 sub-items F & J) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (two more sub-items of #157 shipped; E/H/I remain) |
| **Items modified** | #157 (status comment), MAINT-229 (closed by sub-item F) |
| **Tests added** | +2 backend (`maintenance::tests` — `enqueue_cleanup_orphaned_attachments_smoke_test_157_f`, `enqueue_fts_idle_optimize_smoke_test_157_j`) |
| **Files touched** | 3 |

**Summary:** Ships #157 sub-items **F** and **J** in one PR. Both are pure "enqueue an existing `MaterializeTask` variant on a predicate" entries — the per-job body sits in `maintenance.rs` next to the WAL job; the per-job `MaintenanceJob` literal sits in `lib.rs` next to the existing WAL entry at the daemon spawn site.

- **Sub-item F (`cleanup_orphaned_attachments_tick`)** — 24 h cadence, always-on predicate. Enqueues `MaterializeTask::CleanupOrphanedAttachments` against the materializer background queue. Closes **MAINT-229** (the `lib.rs:725-734` "not scheduled" boot-time shim is now redundant). Always-on predicate because the handler is cheap on a clean install (no orphans → no work) and the cost grows with the orphan set, so the gating is naturally rate-limited by the accumulation pace.
- **Sub-item J (`fts_idle_optimize`)** — 24 h cadence, gated on `materializer.metrics().fts_edits_since_optimize > 0`. Enqueues `MaterializeTask::FtsOptimize`. FTS5 indexes fragment on delete-heavy or update-heavy workloads; the existing `dispatch.rs` optimize only fires on write paths (edit-conditional), so a read-only session after some deletes never runs it. The 24 h tick covers that. The metric resets to 0 inside the `FtsOptimize` handler when it runs, so subsequent ticks return false until more edits accumulate.

**Conflict note:** This PR and the still-open PR #168 (sub-items C & G) both extend the `jobs` vec at the same `lib.rs` spawn site. Whichever lands first cleanly; the second will need a trivial rebase that simply concatenates the two extra `MaintenanceJob` literals into the vec. There is no semantic interaction between F/J and C/G — they're independent jobs on the same daemon.

**Files touched (this session):**
- `src-tauri/src/maintenance.rs` (+58 — two new job-body fns `enqueue_cleanup_orphaned_attachments()` and `enqueue_fts_idle_optimize()`, plus 2 smoke tests)
- `src-tauri/src/lib.rs` (+49 net — extended the `jobs` vec at the daemon spawn site with two more MaintenanceJob entries; added the captures `materializer_for_cleanup`, `materializer_for_fts`, `materializer_for_fts_predicate`)
- `docs/session-log/session-862-…md` (new — this log)

**Verification:**
- `cd src-tauri && cargo check --tests` — clean compile.
- `cd src-tauri && cargo nextest run -p agaric maintenance::` — 6/6 maintenance tests pass.
- pre-commit + pre-push hooks will run on commit/push.

**Process notes:** Used `AppError::Channel(String)` for the enqueue-failure shape — it's the closest fit semantically (the failure is precisely a bounded-channel-full event from `try_enqueue_background`), and there's no `AppError::Internal` variant in this codebase. Either of the two enqueues is a transient backpressure event — the materializer's own saturation path persists the dropped task to `materializer_retry_queue` under the `'__GLOBAL__'` sentinel, so nothing is silently lost.

**Lessons learned (for future sessions):** When two sub-items of the same plan issue both follow the "enqueue an existing MaterializeTask on a predicate" template, bundling them in one PR is correct — the LOC delta is dominated by the per-job MaintenanceJob literal at the spawn site (~25 LOC each), not by any per-task logic, so review surface scales sub-linearly with the bundle size.

**Commit plan:** single commit on branch `feat/maintenance-jobs-cleanup-attachments-fts-optimize-157-F-J`; PR against `main`. Issue #157 stays open (sub-items E, H, I remain). MAINT-229 is closed by sub-item F.
