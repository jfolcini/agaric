# Session 1895 — a restore that brings its page back keeps the page's cache row (#5295)

This is another `/batch-issues` batch from the session that logged 1877. It was
built while #5317 (#5296) waited on CI.

## #5295

- **The bug.** Delete block B, then its page P, then restore B. The #1884
  ancestor-chain walk brings P back as well.
  - The restore hinted the materializer with B's own type, `content`. A
    content restore took a narrowed rebuild set without `RebuildPagesCache`.
    Its premise was that a content block's lifecycle cannot add a page row,
    which is false for a restore.
  - P's delete had already dropped P's `pages_cache` row, and the count tasks
    only update existing rows. P showed no counts and missed the path filters
    until some later op rebuilt the rows.
  - In Trash, P's row stayed listed, and the `[[` picker caches never learned
    that P was back.
- **The fix, backend.** A restore always takes the full rebuild set.
  `narrows_to_content_lifecycle` decides for both the inline set and the
  debounced burst, so the two cannot disagree.
  - That made `CONTENT_RESTORE_REBUILD_TASKS` and the debounce's
    `needs_inheritance` flag dead, so both are deleted. The full set still
    carries the tag-inheritance rebuild the restore set kept.
- **The fix, frontend.** A single-row restore reloads the Trash list, as the
  batch restore and the purge already do. Both restore paths now drop the
  picker name caches for any restore, not only a page's or a tag's.
  - The test that pinned "a content restore does not invalidate" is replaced
    by the #5295 scenario.
  - Two restore tests used a `list_trash` stub that kept listing the restored
    row. They now model the backend.

## Verified

- New Rust tests:
  - `restore_block_inner` and `restore_blocks_by_ids_inner` each restore a block
    trashed before its page, and the page's `pages_cache` row comes back;
  - the materializer unit test pins the full set for a content restore.
- Two mutations were run against a copy, then restored:
  - letting a restore narrow again turns all three red;
  - letting only the debounced burst narrow turns the two command tests red.
    The commands go through that path, so the unit test alone would miss it.
- `cargo nextest run --workspace`: 6695 tests pass. `cargo clippy --workspace
  --all-targets -- -D warnings` is clean.
- `TrashView.test.tsx`: 112 tests pass, and the other Trash and view suites
  pass, 10 files and 314 tests in all. Three mutations were run against a
  copy, then restored, and each turned a new test red:
  - no reload after a single restore;
  - the single-restore invalidation back inside the page and tag branch;
  - no invalidation after a batch restore.
- `npm run typecheck` passes.
