## Session 857 — log appender bounded rotation (#157 sub-item A) (2026-05-28)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-28 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (one sub-item of #157 shipped; the issue stays open for sub-items B-J) |
| **Items modified** | #157 (status comment listing the sub-item shipped + which remain) |
| **Tests added** | -7 (removed the `cleanup_old_log_files` retention-sweep tests; the appender's own `max_log_files` enforcement obviates them) |
| **Files touched** | 2 |

**Summary:** Ships sub-item **A** of issue #157 — replace the unbounded `tracing_appender::rolling::daily(&log_dir, "agaric.log")` setup with `RollingFileAppender::builder().rotation(DAILY).max_log_files(14).filename_prefix(...)` so retention is enforced continuously by the appender itself rather than by a boot-only sweep. Field-observed footprint on a 3-month single-user dev install was 142 MB of logs (per the #157 forensic table); the previous setup had no in-process retention guard between boots, and the boot-time `cleanup_old_log_files` could fail silently. The new builder caps the retained file count at 14 unconditionally, drops the bare daily-rotation no-cap shape, and lets the surrounding `cleanup_old_log_files` function + its 7 unit tests go away with it.

**Out of scope:** `tracing-appender` still has no per-file size cap, so a single bad day can spike one file beyond expectations (the 2026-05-19 file hit 46 MB during a permanently-failing retry-queue loop). The #157 plan says the right fix for that class is the upstream root-cause one in sub-item **D** (`retry_queue_giveup` give-up cap) rather than chasing a per-file ceiling here. That stays open.

**Files touched (this session):**
- `src-tauri/src/lib.rs` (-200 net — appender builder swap, `cleanup_old_log_files` fn deletion at the old line range ~1421-1474, `log_retention_tests` test mod deletion at the old line range ~1565-1712, removal of the boot-time M-45 sweep call)
- `docs/session-log/session-857-…md` (new — this log)

**Verification:**
- `cd src-tauri && cargo check --tests` — clean compile, no new warnings.
- `cd src-tauri && cargo nextest run` — 4015/4016 pass; the single failure is the pre-existing `pagination_walk_all_pages_no_duplicates` flake fixed in the still-open PR #163 (out of scope for this branch). Test count drops from ~4022 to 4016 because the 7 `cleanup_old_log_files` unit tests went away with the function.
- pre-commit hook will run cargo fmt + clippy + nextest at commit time.

**Process notes:** No explicit test for the new appender behaviour — `max_log_files(14)` is enforced by the `tracing-appender` crate itself; the integration is just configuration, not new logic. Adding a test that drives the appender through 15 file-day rolls would be a brittle integration test against the library's internal counting, with low signal. The "measure, don't imagine" rule says skip it. If the appender's behaviour regresses in a future `tracing-appender` upgrade, the next session's bug report (or the field-observed footprint check from #157's acceptance criteria) will surface it.

**Lessons learned (for future sessions):** When a sub-item of a multi-sub-item issue is genuinely independent (sub-item A is standalone — it doesn't depend on the `MaintenanceDaemon` skeleton in B), ship it on its own branch and comment-update the parent issue. The full daemon work in B-J would otherwise hold A hostage to the entire plan landing together.

**Commit plan:** single commit on branch `feat/log-appender-bounded-rotation-157-A`; PR against `main`. Issue #157 stays open (only sub-item A shipped).
