## Session 977 — targeted inbound-sync FTS reindex from the changed-block set (#421) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#421` |
| **Tests added** | +4 dispatch strategy unit tests; existing inbound-sync fan-out test now exercises the per-block path |
| **Files touched** | 5 |
| **Schema / wire-format** | none (no migration, no op type, no `.sqlx` change) |

**Summary:** Every inbound `LoroSync` message that imported (via
`ApplyOutcome::Imported`) called `enqueue_inbound_sync_rebuilds`, which
unconditionally enqueued a full `RebuildFtsIndex` — a `DELETE FROM fts_blocks`
+ `SELECT id, content FROM blocks WHERE deleted_at IS NULL` (every active block
loaded into memory) + full trigram reindex, i.e. `O(vault)` on every sync
message. The changed-block id set was already computed inside `apply_remote`
(`import_with_changed_blocks`, used for the per-block SQL projection) but
**discarded** by `ApplyOutcome::Imported(space_id)`.

Fix (the issue's recommended approach):
1. **Surface the set** — `ApplyOutcome::Imported` is now a struct variant
   `{ space_id, changed_blocks }`; `apply_remote` moves the set it already has
   into the outcome (last use).
2. **Drive FTS from it** — `enqueue_inbound_sync_rebuilds(&changed_blocks)`
   keeps the `FULL_CACHE_REBUILD_TASKS` derived-cache fan-out (unchanged,
   separate concern) and replaces the unconditional full FTS rebuild with the
   pure `inbound_sync_fts_tasks` strategy:
   - empty set (no-op import) → **no** FTS work (was a full rebuild before);
   - ≤ `SYNC_FTS_PER_BLOCK_MAX` changed → one **`UpdateFtsBlock`** per block —
     the same targeted, delete-correct (`update_fts_for_block` DELETEs FTS rows
     for deleted/empty/missing blocks), queue-deduped, consumer-batched path
     local edits already use — turning `O(vault)` into `O(changed)`;
   - above the threshold (snapshot/boot re-sync that can touch ~every block) →
     a single chunked full `RebuildFtsIndex`.

**Why a threshold, and why this value:** `try_enqueue_background` is
non-blocking and drops on a full bounded channel (`BACKGROUND_CAPACITY = 1024`,
#440). Enqueueing one `UpdateFtsBlock` per block for a whole-vault re-sync
would risk saturating the queue and silently dropping FTS updates, so large
imports fall back to the single-task rebuild. `SYNC_FTS_PER_BLOCK_MAX` is
defined as `BACKGROUND_CAPACITY / 4` — a **queue-safety** bound (headroom for
the cache fan-out + concurrent ops), explicitly NOT a measured perf crossover.

**Correctness:** `UpdateFtsBlock` is delete-aware, so a sync that soft-deletes
a block correctly removes its FTS row (verified against `fts/index.rs`
`update_fts_for_block`: missing / `deleted_at IS NOT NULL` / empty content all
`DELETE FROM fts_blocks`). The `FULL_CACHE_REBUILD_TASKS` set is untouched —
targeting those derived caches per-block is a separate documented follow-up.

**Files touched:**
- `sync_protocol/loro_sync.rs` — `ApplyOutcome::Imported` struct variant; move `changed_blocks` into the outcome; updated the in-file test matches.
- `sync_protocol/orchestrator.rs` — destructure `changed_blocks`, pass to the new signature.
- `sync_protocol/tests.rs` — updated `Imported` match sites.
- `materializer/dispatch.rs` — `enqueue_inbound_sync_rebuilds(&[BlockId])`, `inbound_sync_fts_tasks` strategy + `SYNC_FTS_PER_BLOCK_MAX`, +4 unit tests.
- `materializer/tests.rs` — `enqueue_inbound_sync_rebuilds_refreshes_derived_caches` now passes the seeded changed set (exercises the per-block path).

**Verification:**
- New `inbound_sync_fts_tasks_{empty_is_noop, small_set_is_per_block, at_threshold_is_per_block, large_set_is_single_full_rebuild}` pin the strategy at the boundary.
- `enqueue_inbound_sync_rebuilds_refreshes_derived_caches` still asserts the synced content block lands in `fts_blocks` (now via `UpdateFtsBlock`).
- `cargo nextest run materializer:: fts:: sync_protocol:: loro_sync::` → **563 passed**. `cargo clippy --tests` clean on changed files; `rustfmt --check` clean.

**Commit plan:** single commit; branched off `main`; PR against `main`. Reconcile PR #446 (#417) when its CI is green.
