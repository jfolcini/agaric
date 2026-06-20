# Session 1082 — /batch-issues loop: tauri-mock cohort cascade fidelity, batch 30 (2026-06-20)

## What happened

Fresh-backlog test-fidelity item from the overnight `/loop /batch-issues` run, built in
worktree `wt-batch30` and adversarially reviewed (the review caught a real return-value
divergence the conformance suite structurally couldn't).

## Shipped

PR `fix/tauri-mock-cascade-1775`:

- **#1775** (test fidelity) — the TS tauri-mock's single-op `delete_block` /
  `restore_block` handlers didn't cascade like the real backend (surfaced by the #1690
  conformance fixtures). Made them mirror the backend cohort semantics:
  - **delete** (`descendants_cte_active`): BFS-walk the target's descendant subtree,
    descending only into ACTIVE (`deleted_at IS NULL`) children, stamping the same
    cohort marker on all; an already-deleted descendant is a boundary (skipped, its
    independent tombstone preserved). `descendants_affected` = total rows tombstoned,
    **target-inclusive** (matches the backend's `rows_affected()`).
  - **restore** (`descendants_cte_cohort`): read the target's `deleted_at` as the cohort
    marker, walk the subtree descending only into children whose `deleted_at` equals it,
    leaving independently-(earlier-)deleted descendants deleted. `restored_count`
    target-inclusive; live/missing target → 0 no-op.
  - **cohort determinism:** the backend keys cohort identity on `(created_at, seq)`;
    the mock's ms-resolution `Date` could collide on synchronous deletes, so a monotonic
    `cohortSeq` is folded into each delete marker (`<iso>#<seq>`), guaranteeing distinct
    delete ops never share a cohort. The conformance snapshot normalizes `deleted_at` →
    `"DELETED"`, so the marker format is invisible to callers.
  - Un-skipped `cascade_delete_subtree` + `restore_after_cascade_independent_child` from
    `DRIFT_SKIP` (now assert mock==backend), and fixed `loadSeed` to resolve a seeded
    block's `page_id` to its ROOT page (a genuine pre-existing seed-loader bug — the
    move handler already root-resolved; the seed loader didn't — surfaced by un-skipping
    the nested fixtures).

## Review pass

Reviewer found and fixed one CRITICAL fidelity defect: the builder's mock computed
`descendants_affected` **target-exclusive** (0 for a lone delete), but the backend is
target-inclusive (snapshot `snapshot_delete_block_response.snap` returns 1 for a lone
block; `block_cmd_tests.rs` asserts 2 for parent+child). The conformance suite can't
catch this — it snapshots block state, not command return values. Fixed to count
target-inclusive + corrected four test assertions. Verified the delete-cascade and
restore-cohort logic mirror the respective Rust CTEs (scope + boundary + marker-match),
the `cohortSeq` is sound (module-level, intentionally not reset — strictly-increasing
guarantees globally-unique markers), the `loadSeed` fix is a real latent-bug fix that
breaks no other fixture, and the un-skipped fixtures genuinely compare against the
backend snapshot. 2314 tests pass; tsc clean.

## Notes

- Files: `src/lib/tauri-mock/handlers.ts`, `src/lib/tauri-mock/__tests__/conformance.test.ts`,
  `src/lib/__tests__/tauri-mock.test.ts`. Backend untouched.
- Branch base is current `origin/main`.
