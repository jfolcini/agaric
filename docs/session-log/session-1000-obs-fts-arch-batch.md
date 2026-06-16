## Session 1000 — Observability / FTS / arch-diagnostics batch (2026-06-16)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-16 |
| **Subagents** | 5 build + 5 review |
| **Items closed** | `#1340`, `#1321`, `#1316`, `#1326`, `#1333` (+ `#1322` via PR #1363 merged at batch start) |
| **Items modified** | — |
| **Tests added** | +1 (frontend: hardBreak + delimiter-extreme + widened-href properties) / +3 (backend: FTS cap, CommandTx rollback-with-pending, StatusInfo fallback-count delta) |
| **Files touched** | 13 |

**Summary:** Shipped a batch of five independent, well-scoped issues as five separate PRs (#1364–#1368), built and reviewed by ten parallel subagents over a single shared checkout (disjoint file boundaries, no worktrees). The theme was turning silent failure modes into observable ones — FTS truncation, CommandTx rollback discards, and the `sql_only_fallback` counter — plus a stale-doc fix and a property-suite hardening. Also merged PR #1363 (#1322, draft-recovery enqueue) at the batch-start sweep.

**Files touched (this session):**
- `src-tauri/src/lib.rs` (−16) — #1340: rewrote `now_rfc3339()` + `now_rfc3339_tests` comments to match the post-0079 INTEGER-ms op_log model
- `src-tauri/src/fts/strip.rs` (+17), `src-tauri/src/fts/index.rs` (±10), `src-tauri/src/fts/tests.rs` (+27) — #1321: `block_id`-threaded `tracing::warn!` on 128 KB FTS truncation
- `src-tauri/src/db/command_tx.rs` (+63) — #1316: rollback-with-pending `tracing::debug!` diagnostic + Err-discard docstring + bogus-citation fix
- `src-tauri/src/materializer/metrics.rs` (+10), `coordinator.rs` (+3), `handlers/sql_only_fallback.rs` (±7), `tests/fifo_status.rs` (+33) — #1326: surface `sql_only_fallback_count` via `StatusInfo`
- `src-tauri/src/commands/tests/snapshot_tests.rs` (+6) + `.snap` (+1) — #1326: redact the non-deterministic counter field
- `src/lib/bindings.ts` (+12) — #1326: regenerated tauri-specta `StatusInfo` binding
- `src/editor/__tests__/markdown-serializer.property.test.ts` (+140) — #1333: delimiter-extreme / hardBreak / widened-href properties

**Verification:**
- Per-item targeted nextest/vitest run by each builder + re-run by an independent reviewer: FTS 308 passed, command_tx 11 passed, materializer/status/bindings/snapshot 37 passed, markdown property suite 58 passed, now_rfc3339 1 passed.
- Each PR independently adversarially reviewed (no self-reviews); #1316 review confirmed a builder-found bonus fix (nonexistent `bulk_restore_trash_inner` citation → `restore_blocks_by_ids_inner`); #1326 review verified `git diff --ignore-all-space src/lib/bindings.ts` collapses to exactly the one added field.
- pre-commit hook — all staged-file checks pass per branch.
- pre-push hook — full clippy + push-staged checks pass per branch.

**Process notes:** Five disjoint-file issues built in one shared checkout (no worktrees needed — file boundaries verified non-overlapping up front). Commits serialized per-branch off `origin/main`, staging only each issue's files; prek's per-commit patch-stash kept the other in-flight issues' unstaged changes intact. Deferred `#1240` (fuzz lane) — the issue itself documents it as locally unverifiable (no nightly+cargo-fuzz; the `generate_context!` E0063 needs a ~20-min `workflow_dispatch` to test), so shipping a guess is worse than tracking it.

**Commit plan:** pushed — five PRs #1364 (#1340), #1365 (#1321), #1366 (#1316), #1367 (#1326), #1368 (#1333); this session-log entry tracked separately.
