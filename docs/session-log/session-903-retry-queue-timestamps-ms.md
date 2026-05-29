## Session 903 — #109 Phase 2: materializer_retry_queue timestamps → INTEGER ms (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | orchestrator-only |
| **Items closed** | — |
| **Items modified** | #109 (Phase 2, table 4 of ~10) |
| **Tests added** | 0 (existing retry_queue/materializer suites cover it; fixtures updated) |
| **Files touched** | 6 |

**Summary:** Fourth table of #109 Phase 2 — migrate `materializer_retry_queue.created_at`
and `next_attempt_at` from TEXT to INTEGER epoch-ms. Independent of the `op_log.created_at`
cluster (both columns self-generated; `next_attempt_at` compared only against a
self-computed cutoff in `fetch_due`, `created_at` diffed against now in `give_up_reason`).
Also resolves the format-mixing #109 flagged: the old `DEFAULT CURRENT_TIMESTAMP`
(space-separated TEXT) vs the RFC 3339 sweeper writes — both backfill uniformly via
`julianday`, and the new INTEGER `DEFAULT (strftime('%s','now')*1000)` removes the
divergence.

**Files touched (this session):**
- `src-tauri/migrations/0077_retry_queue_timestamps_ms.sql` (new — rebuild, STRICT, INTEGER `DEFAULT` + `CHECK >= 0`, recreates `idx_materializer_retry_queue_due`, `julianday` backfill)
- `src-tauri/src/materializer/retry_queue.rs` (`next_attempt_at` = `now_ms() + backoff.num_milliseconds()`; `give_up_reason` integer-ms age math; `DueRow.created_at: String→i64`; `fetch_due` cutoff `now_ms()`; test fixtures)
- `src-tauri/src/materializer/tests.rs` (2 `next_attempt_at` insert fixtures → epoch-ms)
- `src-tauri/.sqlx/*` (3 query files regenerated — `created_at`/`next_attempt_at` now i64)

**Verification:**
- `SQLX_OFFLINE=true cargo check --all-targets` — 0 errors, 0 warnings.
- `cargo nextest run retry_queue materializer` — 237 passed.

**Process notes:** STRICT was the load-bearing tripwire — it surfaced two `next_attempt_at`
insert fixtures in `materializer/tests.rs` (a different file from the table's module) that
still bound RFC 3339 strings (`cannot store TEXT value in INTEGER column`). Also nearly
mis-converted an `OpRecord` `created_at` fixture (op_log.created_at is still TEXT — part of
the not-yet-migrated cluster) sharing the same literal; reverted it. Lesson: grep the whole
tree for inserts into the migrated table, not just its own module.

**Commit plan:** single commit / pushed.
