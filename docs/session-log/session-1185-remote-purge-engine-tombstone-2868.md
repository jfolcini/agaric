## Session 1185 — Remote purge clears the engine tombstone (#2868) (2026-07-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-22 |
| **Subagents** | 1 build + 1 verify/review |
| **Items closed** | `#2868` |
| **Items modified** | — |
| **Tests added** | +0 (frontend) / +1 (backend, plus proptest doc updates) |
| **Files touched** | 4 |

**Summary:** Fixed a cross-peer CRDT correctness bug: a **remotely-applied `PurgeBlock`**
cleaned SQL but left the per-space Loro engine tombstone in place, so a snapshot-syncing
peer could resurrect the purged block as trash. The remote materializer purge path
resolved the block's space via `resolve_block_space` (which filters `deleted_at IS NULL`),
and since a purge always targets an already soft-deleted block, resolution returned `None`
— the apply recorded a `sql_only_fallback` and cleaned only SQL. The fix resolves the
space via a new soft-delete-tolerant reader captured **before** the SQL cascade, so the
existing `engine.apply_purge_block` runs and prunes the whole subtree from the LoroDoc,
matching the LOCAL purge path's engine effect.

**Files touched (this session):**
- `src-tauri/agaric-store/src/space.rs` (+36) — new `resolve_soft_deleted_block_space`:
  reads the denormalized `blocks.space_id` column **without** the `deleted_at IS NULL`
  filter (a runtime `query_scalar`, so no `.sqlx` regeneration is needed). Returns
  `Ok(None)` only for an absent block or a genuinely NULL `space_id` (pre-spaces data).
- `src-tauri/agaric-engine/src/apply/loro_apply.rs` (+28/-) — `apply_purge_block_via_loro`
  now resolves space via the soft-delete-tolerant reader before `purge_block_sql_cascade`,
  so `engine.apply_purge_block` clears the seed + descendant tombstones; the SQL-only
  fallback arm is now taken only when space is genuinely unresolvable.
- `src-tauri/src/materializer/handlers/engine_path_tests.rs` (+123) — new regression test
  `apply_op_tx_remote_purge_of_soft_deleted_block_clears_engine_tombstone_2868`: soft-deletes
  the seed (the purge precondition + the exact trigger), asserts the engine tombstone
  exists pre-purge (non-vacuous), applies the purge through `apply_op_tx` (the REMOTE
  inbound path, not the local command), then asserts `read_block` / `read_deleted_at` are
  `None` (tombstone fully cleared) and the `sql_only_fallback` delta is zero (the engine
  arm actually ran). Discriminates against the sibling `apply_op_tx_purge_block_engine_path`,
  which purges a LIVE block whose space resolves regardless and so passed even with the bug.
- `src-tauri/src/materializer/handlers/apply_reproject_proptest.rs` (+21/-12) — doc-comment
  updates: purge is no longer dropped from the reprojection / LOCAL-vs-REMOTE parity
  properties because of the SQL-only arm (that's fixed since #2868); it stays out for
  STRUCTURAL reasons (terminal op + a distinct LOCAL command path, not the shared apply
  kernel). Points at the new dedicated engine-tombstone coverage.

**Verification:**
- `cd src-tauri && cargo nextest run -E 'test(apply_op_tx_remote_purge_of_soft_deleted_block_clears_engine_tombstone_2868)'` — 1 passed.
- `cargo nextest run -E 'test(purge)'` — 77 tests run, 77 passed.
- `cargo nextest run -E 'test(apply_reproject)'` — 5 passed.
- `cargo check --all-targets` — clean, no warnings; `cargo clippy --all-targets -- -D warnings`
  on `agaric-store` / `agaric-engine` / `agaric` — clean.

**Process notes:** The build subagent died mid-run on a container restart, leaving a
complete uncommitted diff; a continuation subagent verified it in the foreground
(per the batch-issues "continuation-as-review" pattern) and needed zero mechanical
fixes — every API name in the inherited diff was already correct.
