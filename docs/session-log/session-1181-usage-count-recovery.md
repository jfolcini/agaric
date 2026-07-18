# Session 1181 — durable usage_count refresh recovery (#2831)

## Scope

Deep-review follow-up: `tags_cache.usage_count` refresh was coupled to the transient
`ReindexBlockTagRefs` diff, so a lost or failed refresh was **not recoverable on retry**.

Closes #2831.

## The bug

#2659 refreshed `usage_count` only for the tags in the reindex diff (the symmetric
difference between a block's current `#[ULID]` tag refs and its existing `block_tag_refs`
rows). The **only** signal that a refresh was owed was that transient in-memory diff. If a
`refresh_tag_usage_count` call errored (WAL contention) or the process crashed mid-loop, the
`ReindexBlockTagRefs` task retried — but by then the `block_tag_refs` write had already
committed, so the retry re-derived an **empty** diff, the refresh loop ran zero times, and
`usage_count` stayed stale until an unrelated AddTag/RemoveTag or a full `RebuildTagsCache`
healed it.

## Fix — durable, atomic obligation

Decouple "a refresh is owed" from "the diff was non-empty this run" by persisting the
obligation atomically with the diff:

- **`agaric-store/src/cache/block_tag_refs.rs`** — extracted transactional cores
  `reindex_block_tag_refs_in_tx(&mut SqliteConnection, block_id)` and
  `reindex_block_tag_refs_split_in_tx(&mut write_conn, read_pool, block_id)` that run the
  read → diff → DELETE/INSERT and return the changed tags **without committing**. The public
  `reindex_block_tag_refs` / `_split` are now thin begin/commit wrappers (API unchanged;
  store reindex tests still pass).
- **`src/materializer/retry_queue.rs`** — `seed_refresh_tag_usage_count_obligation_tx(&mut
  conn, tag_id)`: idempotent `INSERT … ON CONFLICT(block_id, task_kind) DO NOTHING`,
  `attempts = 1`, `next_attempt_at = now`; plus `clear_refresh_tag_usage_count_obligation`.
- **`src/materializer/handlers/task_handlers.rs`** — the `ReindexBlockTagRefs` arm now owns
  **one** write transaction: it runs the diff via the `*_in_tx` core, seeds a tag_id-keyed
  `RetryKind::RefreshTagUsageCount` obligation on the **same** tx for each changed tag, then
  commits once. The inline refresh still runs and clears the obligation on success; on
  failure/crash the durable, tag_id-keyed row is left for the periodic sweeper to retry to
  completion — independent of any future (empty) reindex diff. `handle_background_task` was
  split into unmetered (test) / metered (prod) / shared `_inner` variants to thread
  `QueueMetrics`.

No migration — `RefreshTagUsageCount` already exists and is exercised by the
AddTag/RemoveTag path. One new `.sqlx` offline entry for the seed INSERT.

## Tests

`reindex_block_tag_refs_usage_count_recovers_via_durable_obligation_2831` reconstructs the
post-crash state (ref row present, `usage_count` stale, obligation seeded), asserts the
empty-diff retry does **not** heal (the #2831 hole), then proves the durable obligation
drives `sweep_once` → drain → `usage_count` healed and the row cleared. The #2659
immediate-refresh happy path still passes.

## Review

Adversarial review independently confirmed: single-transaction atomicity (one
`begin_immediate` tx, same `&mut tx` to both the diff and the seed, `commit()` exactly once,
no window); gauge balance across seed/clear/sweep paths; the concurrent-same-tag lost-refresh
interleaving is unreachable (single sequential background consumer + `BEGIN IMMEDIATE`); the
metrics refactor drops/reorders no arm; `.sqlx` is exactly +1 with the baseline intact
(`sqlx prepare --check` exit 0); the new test would not compile against the pre-fix code.
59/59 targeted tests + clippy `-D warnings` clean on both `agaric` and `agaric-store`.

## Notes

- Disjoint from the in-flight crate-split PR #2871 (sync cluster → `agaric-sync`); the
  materializer/cache/retry-queue domain is untouched by that move.
