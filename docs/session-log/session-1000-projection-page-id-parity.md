# Session 1000 — projection `page_id` parity (#1324)

`/loop /batch-issues` run (2026-06-16). Single focused backend batch — the PR pipeline was
already near the 5-PR cap (4 open: #1352–#1355, all CI-pending), so one clean issue shipped
rather than a wide fan-out.

## Shipped

- **#1324 — Materializer CreateBlock projection omits `page_id` for page blocks.** The two
  live projection entry points INSERT-ed page blocks with `NULL page_id`, which migration
  0073's `page_id_self_for_pages` CHECK (`block_type != 'page' OR page_id = id`) rejected —
  failing the op and blocking the materializer queue for any synced / op-log-replayed page
  create. The command path (`block_ops.rs:273-274`) already stamped `page_id = id`; this
  brings the projection path to parity:
  - `src-tauri/src/loro/projection.rs` — `project_create_block_to_sql` (Loro engine path).
  - `src-tauri/src/materializer/handlers/sql_only.rs` — `apply_create_block_sql_only`
    (space-unresolved / engine-uninit fallback).
  - `src-tauri/src/loro/projection.rs` — `project_block_full_to_sql` (the **canonical
    sync-pull reproject** path, called by `apply_remote` for every changed block). The
    adversarial reviewer flagged this third live path, which the issue did not list; its
    upsert now stamps `page_id = id` for pages on insert **and** on the `ON CONFLICT` branch
    via a `CASE` that leaves a non-page block's already-resolved `page_id` untouched (so a
    re-projection never clobbers a child's `page_id` back to NULL).
  - Page blocks now stamp `page_id = id`; non-page blocks keep `NULL` (the deferred
    `SetBlockPageId` task continues to fill those from the parent).
  - Regression tests added across all three paths: page → `page_id = id`, non-page → `NULL`,
    and the reproject-no-clobber case. `.sqlx` regenerated (`--all-targets`); offline-cache
    `--check` passes.

**Corrected mechanism (per review).** The issue framed this as the `page_id_self_for_pages`
CHECK *rejecting* the row and blocking the materializer queue. That is inaccurate: the CHECK
`block_type != 'page' OR page_id = id` evaluates to `FALSE OR (NULL = id)` = `NULL` (unknown)
for a page with NULL `page_id`, and SQLite rejects a CHECK only when it is FALSE — so the row
is **accepted** with NULL `page_id`. The real defect is silent, not fail-blocking: the
deferred `SetBlockPageId` task is deliberately skipped for page blocks
(`materializer/dispatch.rs:445-452`), so nothing ever fills a synced/replayed page's
`page_id`; it stays NULL-owned and drops out of every `page_id`-scoped read (page listing,
backlinks, subtree) until a full cache rebuild. The fix stamps it at projection time, matching
the command path. Code/test comments were corrected to this mechanism. This completes the
**Path-B** projection-parity work left over from #111.

## Verification

- Targeted nextest (`materializ`/`projection`/`conformance`/`page_id`/`create_block`):
  427 passed, 0 failed.
- Independent adversarial reviewer subagent: corrected the issue's stated CHECK-rejection
  mechanism (NULL passes the CHECK) and found the third uncovered `project_block_full_to_sql`
  sync path — both addressed above.
- Full Rust suite after the expanded fix: **4194 passed, 0 failed**;
  `cargo sqlx prepare --check` clean.

## Method

Backend-only change → orchestrator built, separate adversarial reviewer verified + owned the
full-suite run (no self-review). No UX reviewer (no user-facing surface).
