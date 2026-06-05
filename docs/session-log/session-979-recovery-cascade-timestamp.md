## Session 979 — migration-73 recovery: cascade delete + preserve op timestamp (#429) (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Items closed** | `#429` |
| **Dimension** | correctness (corruption-recovery path; not scaling) |
| **Tests added** | +1 backend (cascade + cohort timestamp through the recovery replay) |
| **Files touched** | 1 |
| **Schema / wire-format** | none (no migration; runtime `sqlx::query`, no `.sqlx` change) |

**Summary:** `recover_blocks_from_op_log` (the partial-migration-73 "blocks table
missing" recovery in `db.rs`) replayed each `delete_block` op as a single-row
`UPDATE blocks SET deleted_at = ? WHERE id = ?` binding the root block id and a
freshly-computed boot-time `now`. Two divergences from the production delete
(`delete_block_inner`, which walks the active descendant CTE and stamps the op's
own timestamp):
1. **No cascade** — a `delete_block` op encodes ONLY the root (descendants are
   soft-deleted by the production cascade, not by separate ops), so recovery
   left every descendant `deleted_at = NULL` → they reappear **live/orphaned
   under a tombstoned ancestor**.
2. **Timestamp clobbered** — every recovered deletion got the same boot-time
   `now`, collapsing all deletions into one cohort and breaking the
   `(seed, deleted_at)` grouping `list_trash` and `restore_block` rely on.

Fix (both in the delete arm):
- **Cascade** through the temp `blocks` tree with a depth-bounded
  (`depth < 100`) recursive `descendants` CTE, `WHERE deleted_at IS NULL` so an
  already-deleted descendant keeps its original cohort timestamp — same shape
  as `descendants_cte_active!()` / the purge cascade.
- **Stamp the op's own `created_at`** via the new `op_created_at_rfc3339`
  helper. `created_at` is INTEGER-ms post-migration 0079/0080 but original
  TEXT on older DBs that can still reach this path, so the helper reads either
  and renders rfc3339 (the recovery temp table's `deleted_at` is TEXT; after a
  `DROP TABLE` no later type-conversion migration re-runs).

**Why correct & bounded:** fires only on an already-corrupted DB. The cascade
re-derives the subtree from the temp `blocks` parent links built by the prior
replayed create/move ops; the `IS NULL` guard preserves earlier cohorts; the
op timestamp gives each delete op a distinct, shared-within-cohort
`deleted_at`.

**Files touched:**
- `db.rs` — `op_created_at_rfc3339` helper; delete arm now cascades + stamps the op timestamp; select `created_at` in the replay query; +1 test.

**Verification:**
- New `init_pool_recovery_cascades_delete_and_keeps_op_timestamp_429`: seeds
  PAGE→CHILD→GRAND creates + a `delete_block` of the page (root only) with a
  2020 `created_at`, drops `blocks`, reopens. Asserts (a) no subtree member is
  left live (cascade), (b) all three share one `deleted_at` (cohort), (c) it is
  a 2020 rfc3339 string, not boot-time `now`.
- `cargo nextest run db:: soft_delete:: pagination::trash` → **79 passed**
  (existing recovery tests `init_pool_recover_blocks_from_op_log_73` etc. still
  green). clippy + rustfmt clean.

**Commit plan:** single commit; branched off `main`; PR against `main`. Reconcile
the earlier open PRs (#446 #447 #448) once their slow CI `build` jobs are green.
