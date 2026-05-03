# PEND-03 — Materializer silent drop of global cache rebuilds

## Problem

The materializer's background queue (1024 capacity) silently drops tasks when full at <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/materializer/coordinator.rs" lines="577-603" /> (`try_enqueue_background`). Per-block idempotent tasks (`UpdateFtsBlock`, `ReindexBlockLinks`, `ReindexBlockTagRefs`) are persisted to `materializer_retry_queue` (migration `0028_materializer_retry_queue.sql`) on failure, with exponential backoff (1m → 5m → 30m → 1h).

**Global cache rebuilds (`RebuildTagsCache`, `RebuildPagesCache`, `RebuildAgendaCache`, `RebuildProjectedAgendaCache`, `RebuildTagInheritanceCache`, `RebuildPageIds`, `RebuildBlockTagRefsCache`) are NOT persisted.** If dropped due to queue saturation or handler failure, the cache stays stale until the next mutation on the affected entity triggers a re-dispatch. The staleness window is undocumented in AGENTS.md.

## Root cause

Global cache rebuilds are treated as non-retryable in <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/materializer/retry_queue.rs" lines="44-52" /> (the `RetryKind` enum) because they're "re-dispatched by other code paths" (consumer.rs:535-537). This assumption breaks under sustained backpressure: if the queue fills faster than it drains, a global rebuild can be dropped before the next mutation occurs.

The silent drop is visible only via the `bg_dropped` counter; there's no persistent record and no automatic re-enqueue. Per-block tasks avoid this via `materializer_retry_queue`, but the schema is block-scoped (`PRIMARY KEY (block_id, task_type)`) and cannot represent global tasks.

## Goals & non-goals

**Goals:**

- Ensure global cache rebuilds are not silently lost on queue saturation or handler failure.
- Document the staleness window in AGENTS.md "Backend Architecture" section.
- Add observability to distinguish dropped global tasks from dropped per-block tasks.

**Non-goals:**

- Refactor the materializer's two-tier retry model (in-memory + persistent).
- Add a manual "rebuild all caches" admin command (orthogonal feature).
- Change the dedup strategy or queue capacity.

## Approach

**Option A — Extend `materializer_retry_queue` to support global tasks (recommended).**

Modify the schema to allow `block_id = NULL` for global tasks, and rename `task_type` to `task_kind` to widen its semantic. Global rebuilds are idempotent and deterministic — they can be safely persisted and re-enqueued with the same backoff as per-block tasks. Dedup ensures multiple dropped `RebuildTagsCache` failures coalesce into one retry row.

**Why A:** minimal schema change, reuses proven retry infrastructure, aligns with the principle that idempotent tasks should be persisted.

**Option B — Document staleness + add metric + manual rebuild command.**

Document the max ~5-minute window (until next mutation) in AGENTS.md, add a `bg_dropped_global` counter to `QueueMetrics`, add a Tauri command `rebuild_all_caches_now()`. No schema change, lower implementation cost, but leaves the correctness gap if no mutations occur.

**Chosen: Option A.** Correctness over cheapness. The schema change is small and the retry infrastructure is proven.

## Files touched

| File | Change |
| --- | --- |
| `src-tauri/migrations/0042_materializer_retry_queue_global_tasks.sql` | New migration. Allow `block_id NULL`. Add/rename `task_kind`. Recreate primary key. |
| `src-tauri/src/materializer/retry_queue.rs` | Extend `RetryKind` enum, update `from_task()`/`to_task()`/`record_failure()`/sweeper to handle global tasks. |
| `src-tauri/src/materializer/consumer.rs` | Replace silent-drop path for global tasks (lines ~535-539) with `record_failure()` call. |
| `src-tauri/src/materializer/coordinator.rs` | Add `bg_dropped_global` counter alongside `bg_dropped`. Bump appropriately in `try_enqueue_background`. |
| `AGENTS.md` | Update "Backend Architecture" section: document the persistence guarantee + staleness window (max 1h via backoff). |

## Migration impact

Yes, a new SQL migration. The current schema has `block_id TEXT NOT NULL` and `PRIMARY KEY (block_id, task_type)`. SQLite doesn't support modifying constraints in place; the standard idiom is table recreation.

**Reviewer correction:** the original draft used a nullable `block_id` in the composite primary key. Under SQLite's `STRICT` mode (which we want here, per PEND-07), `PRIMARY KEY` columns are `NOT NULL`. **Use a sentinel `'__GLOBAL__'` literal as the `block_id` for global tasks** — keeps the PK shape intact, makes dedup natural, and matches the table's existing semantic ("retry-queue rows are keyed by what they're targeting").

```sql
-- 0042_materializer_retry_queue_global_tasks.sql
CREATE TABLE materializer_retry_queue_new (
    block_id   TEXT NOT NULL,        -- block_id for per-block tasks; '__GLOBAL__' literal for global rebuilds
    task_kind  TEXT NOT NULL,        -- new column, replaces task_type; covers per-block AND global variants
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (block_id, task_kind)
) STRICT;

INSERT INTO materializer_retry_queue_new (block_id, task_kind, attempts, last_error, created_at, next_attempt_at)
  SELECT block_id, task_type, attempts, last_error, created_at, next_attempt_at
  FROM materializer_retry_queue;

DROP TABLE materializer_retry_queue;                                  -- drop old immediately, no orphan
ALTER TABLE materializer_retry_queue_new RENAME TO materializer_retry_queue;

CREATE INDEX IF NOT EXISTS idx_materializer_retry_queue_next
    ON materializer_retry_queue (next_attempt_at);
```

**Notes:**

- The new table uses `STRICT` (PEND-07 policy applied here for the first time).
- Old table is dropped immediately after the rename; no `materializer_retry_queue_new` orphan if a crash interleaves the migration.
- Dedup is automatic: two failed `RebuildTagsCache` tasks both write `('__GLOBAL__', 'RebuildTagsCache')`, the second overwrites the first via `INSERT OR REPLACE` semantics in `record_failure()`.

Migration is fast (retry queue is rarely large). Single-shot, runs at app startup, locks the DB for milliseconds.

## RetryKind enum extension

`retry_queue.rs::RetryKind` currently has 3 variants (UpdateFtsBlock, ReindexBlockLinks, ReindexBlockTagRefs). Extend with **7 new variants**, one per global rebuild type:

```rust
pub(crate) enum RetryKind {
    // Per-block (existing)
    UpdateFtsBlock,
    ReindexBlockLinks,
    ReindexBlockTagRefs,
    // Global (new — see dispatch::FULL_CACHE_REBUILD_TASKS for the canonical list)
    RebuildTagsCache,
    RebuildPagesCache,
    RebuildAgendaCache,
    RebuildProjectedAgendaCache,
    RebuildTagInheritanceCache,
    RebuildPageIds,
    RebuildBlockTagRefsCache,
}
```

`RetryKind::from_task()` and `RetryKind::to_task()` get the 7 new arms; the per-block arms read `block_id` from the row, the global arms read the sentinel and ignore it on reconstruction. Test the round-trip in `test_global_task_persistence`.

## Testing

In `src-tauri/src/materializer/retry_queue.rs` `#[cfg(test)] mod tests`:

- `test_global_task_persistence` — verify `RebuildTagsCache` is recognized by `RetryKind::from_task()`, persisted via `record_failure()`, reconstructed via `to_task()`.
- `test_global_task_backoff` — verify the 1m → 5m → 30m → 1h schedule applies to global tasks.
- `test_global_task_dedup` — enqueue two `RebuildTagsCache` failures rapidly; verify a single row in `materializer_retry_queue`.

In `src-tauri/src/materializer/tests.rs`:

- `test_global_task_dropped_on_queue_full` — fill the background queue, dispatch a `RebuildTagsCache`, verify it's dropped AND persisted to retry queue.
- `test_global_task_re_enqueued_after_backoff` — persist a `RebuildPagesCache` failure, advance time by 1m via tokio test-util, run sweeper, verify task is re-enqueued and processed.

Schema snapshot (insta):

- `materializer_retry_queue_schema` snapshot pinned via `cargo insta` after migration 0042.

Metric tests:

- Verify `bg_dropped` and `bg_dropped_global` increment correctly.

## Cost

**M (4-7 hours).** Revised after reviewer pointed out 7 enum variants (not 1), explicit sentinel handling, and parity tests for each variant round-trip.

| Step | Time |
| --- | --- |
| Migration design + SQL | 0.5h |
| `RetryKind` enum extension (7 variants) + `from_task`/`to_task` | 1.5h |
| `record_failure` + sweeper sentinel handling | 1h |
| Consumer integration (remove silent drop) | 0.5h |
| AGENTS.md doc section | 0.5h |
| Tests (unit + integration + snapshot, including round-trip per variant) | 2-2.5h |
| Code review + iteration | 1h |

## Impact

**Correctness: high.** Eliminates a silent data-consistency gap. Global cache rebuilds are guaranteed to complete (with bounded staleness) even under sustained backpressure.

**Performance: low.** Retry queue ops are O(1) PK lookups; sweeper runs every 60s on a separate thread. No hot-path impact.

**Maintainability: medium.** Adds complexity to `retry_queue.rs` (global tasks have no `block_id`), but the schema change is backward-compatible in spirit, and future cache rebuild types automatically benefit from persistence.

## Risk

**Low.** Additive change (new migration, extended enum, new code path). Existing per-block retry logic untouched. Global tasks are idempotent — re-enqueuing is safe. Standard SQLite table recreation pattern. Sentinel `'__GLOBAL__'` is a reserved-prefix literal that cannot collide with a real ULID block id (ULIDs are 26 char Crockford base32 uppercase; the sentinel is lowercase + underscores).

**Edge cases to watch:**

- Sweeper re-enqueuing global tasks while queue still full → tasks re-dropped, re-persisted, re-enqueued on next sweep. This is correct (eventual consistency) but can churn. Sentinel-keyed dedup at the SQL layer (PK uniqueness) mitigates within a single retry cycle; in-memory dedup in `dedup.rs` should also recognize that two RebuildTagsCache tasks coalesce regardless of source.
- Migration on large databases — table recreation locks DB for the migration duration. Single-user, offline-first, runs at startup; not a user-visible problem.
- The existing AGENTS.md staleness-window phrasing should say **"until the next block-structure mutation (delete/restore/purge) re-dispatches the rebuild, OR until the persistent retry-queue sweeper picks it up (worst case 1h via backoff)"** — not "5 min." There is no 5-minute floor on re-dispatch; it depends on user activity.

## Rollout

Single PR. Migration + code + tests + docs in one commit. No feature flag needed (backward-compatible behavior). Land in next release.

## Open questions

1. Should the retry interval cap stay at 1h for global tasks, or extend (e.g., 4h) since they're more expensive than per-block? **Recommendation: keep 1h.** A 1h staleness window is the practical worst case (a user editing a single block in 60 min triggers re-dispatch sooner). 4h would be too long for the agenda case.
2. Should the migration drop the old `task_type` column entirely or alias it? **Recommendation: drop and rename to `task_kind` in one shot via the table-recreation pattern above.** No external consumers; the table is internal materializer state.
3. Should we add a `last_succeeded_at` column to track health of global tasks? **Defer.** Telemetry-shaped, can be added later if drift is observed in practice.
4. Should `bg_dropped_global` and `bg_dropped` be separate counters (per the original draft) or one with a `task_kind` label? **Recommendation: keep them separate** — operationally easier to glance at.
