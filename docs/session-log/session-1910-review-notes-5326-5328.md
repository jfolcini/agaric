# Session 1910 — review notes from #5326 and #5328

This is the last batch of the session that logged 1873, 1882, 1884, 1887,
1890, 1902 and 1907. #5328 (#5272) merged after `validate-all` and `dco`
passed and the reviewer had approved. This PR carries the non-blocking
notes from the sweep's merges.

## The notes

- **#5326.** The review had no notes.
- **#5328, the stale comment.** The #4729 comment in
  `use-block-action-orchestration.ts` still said the exemption is
  registered before the first await because of `edit()`. Since #5272 the
  first await is `createBelow`, and `edit()` is the second. The comment
  is fixed. No code changed.
- **#5328, undo after a failed split.** The compensating `remove()` calls
  use the default `undoable: true`. After a failed split, the create and
  the delete therefore sit on the undo stack. The user's next Ctrl+Z
  cancels that rollback, with no visible effect, instead of undoing their
  previous action.
  - No change. `remove(id, { undoable: false })` would leave the create's
    entry alone on the stack, and its undo would delete a block that is
    already deleted. That is worse than a no-op step.
  - Before #5272, a failed split left an edit and a compensating edit,
    which was also a no-op pair.
  - A failed split needs a backend error, so this is rare.

## Also from this session

- #5332 collects the brand-level design choices the visual polish pass
  (#5271, session 1873) left open. It also records the contrast failures
  that stay until they are decided.
- Code-scanning alert #280 (`js/index-out-of-bounds` in
  `markdown-serializer.property.test.ts`) is a false positive. The loop
  visits the boundary after the last node on purpose, and both helpers
  handle `undefined`. This session's GitHub access cannot dismiss alerts,
  so it is left for the maintainer.

## Verified

- The diff is comment-only. `npm run typecheck` exits 0, and the
  orchestration tests pass.
