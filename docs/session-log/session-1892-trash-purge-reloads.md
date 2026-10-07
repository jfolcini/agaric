# Session 1892 — a single purge reloads the trash list (#5297)

This is another `/batch-issues` batch from the session that logged 1877.

## Board

- #5309 (#5283) and the review-note follow-up #5312 merged.
- Another session holds #5275, #5276, #5277, #5279, #5281, #5282, #5285 and
  #5289–#5292.
- #5297 was unclaimed and the smallest well-scoped item left.

## #5297

- **The bug.** `purge_block` erases the whole subtree, including descendants
  trashed earlier, which list as their own rows. `TrashView`'s single-row purge
  only filtered out the purged row, so those descendants stayed listed until
  the next reload. Restoring or purging one then failed, because it no longer
  existed.
- **The fix.** A successful single purge reloads the list, as the batch purge
  already does.

## Verified

- `TrashView.test.tsx`: 111 tests pass. The new test lists page P and its
  earlier-trashed block B, purges P, and expects B's row to disappear.
- Removing the `reload()` call in a copy turns that test red. The copy was
  then restored.
- Every other test file that renders `TrashView` or its hooks passes: 9 files,
  202 tests.
- `npm run typecheck` and oxlint pass.
