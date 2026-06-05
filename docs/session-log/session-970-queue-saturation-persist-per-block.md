## Session 970 — Persist per-block tasks dropped on queue saturation (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Subagents** | orchestrator build + 1 review |
| **Items closed** | `#423` |
| **Items modified** | — |
| **Tests added** | +1 backend (`test_per_block_task_dropped_on_queue_full`) |
| **Files touched** | 2 |

**Summary:** Fourth batch of the 2026-06-05 SQL backend audit. When the bounded
background materializer channel is full, the coordinator previously persisted
only *global* cache-rebuild tasks to `materializer_retry_queue`; per-block
reindex tasks (`UpdateFtsBlock`, `ReindexBlockLinks`, `ReindexBlockTagRefs`) were
dropped without persistence. Because a task shed at enqueue time never reaches
the consumer's failure path, the affected block's FTS / link / tag-ref index
went stale until its next edit, with no self-healing. The fix persists **all**
retryable dropped tasks (`record_failure` derives the per-block `block_id` or the
`'__GLOBAL__'` sentinel from the task); `bg_dropped_global` still ticks only for
globals so operators can distinguish a cache-freshness gap from a per-block
reindex backlog.

**Files touched (this session):**
- `src-tauri/src/materializer/coordinator.rs` — saturation-drop path now persists per-block retryable tasks too; corrected the comment that wrongly claimed per-block tasks were covered by `consumer.rs`.
- `src-tauri/src/materializer/tests.rs` — `test_per_block_task_dropped_on_queue_full`.
- `src-tauri/.sqlx/*` (one new test query).

**Verification:**
- `cargo nextest run -E 'test(materializer) or test(retry_queue)'` — 246 tests run, 246 passed (incl. the new test and the existing global-drop / sweeper round-trip tests).
- Review subagent: confirmed `record_failure` persists the real per-block `block_id`, the sweeper's `to_task` round-trips per-block kinds back to real tasks, non-retryable tasks (`RebuildFtsIndex`/`FtsOptimize`/…) still drop without persistence, and `bg_dropped_global` stays global-only.

**Commit plan:** single commit; pushed; PR against `main`.
