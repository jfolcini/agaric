# Session 1884 — five medium findings from the stale-state audit

This session continues session 1874 after #5300 merged. It takes five of the
medium-severity issues the audit filed (#5276, #5279, #5281, #5282, #5285).
Each one had its own builder and its own reviewer.

## What shipped

- **#5279: "Move to space" offered the page's own space.**
  - The filter read a `space` property row that migrations 0087/0088
    removed, so it removed nothing.
  - It now filters on the current space, the same as the Pages-view batch
    toolbar, and the entry hides when no other space exists.
  - The dead `pageSpaceId` state is gone.
  - The mock no longer returns `space` rows from `get_properties`,
    `get_batch_properties` or `get_property`. It still stores the row
    internally, because about 30 space-scoped mock queries read it.
- **#5276: History-view Revert / Restore-to-here and Agent-access Undo /
  Revert session left titles, chips and the Graph stale.**
  - They now call `reloadAfterRevert()`, the sync path's "reload everything
    held" fan-out plus `refreshDeleted`.
  - Two cases stay stale, and both share the resolve store's merge-only
    preload with #5289:
    - a chip to a page whose CREATE was reverted;
    - a `((block))` chip to a content block, on a page that is not open,
      whose edit was reverted.
- **#5282: a file attached with `/attach` or by paste/drop did not show.**
  - Both paths now call `recordAttachmentInvalidation()`. The provider's
    cached `[]` for the block is refetched.
- **#5285: completing a repeating task did not show the next occurrence.**
  - After a successful move to DONE, `reloadIfRepeating` looks up `repeat`.
    Only when it is set does it reload the page store.
  - The four DONE paths are the gutter checkbox / Ctrl+Enter / context menu,
    `/done`, typed `[x]` and the blur flush.
  - `load()` shows the skeleton and drops the caret, as the sync, undo,
    paste and duplicate reloads already do.
- **#5281: renaming or restoring a tag onto a name a live tag already holds
  hid one of the two.**
  - Tag renames and the single and batch restore paths now refuse with
    `ValidationCode::DuplicatePageTitle`. The comparison uses
    `normalize_tag_name` within the space.
  - The restore check runs inside the transaction after every write, so a
    refusal restores nothing and appends no op.
  - Sync and apply paths are untouched, because collisions from sync are
    accepted (#626).
  - TagList's guard is now case-insensitive.
  - TrashView names the cause instead of "Failed to restore block".
  - A backend-authored conformance fixture pins the rule on both sides.

## Verified

- Each new test was shown red by reverting its fix in a scratch-backed copy,
  restored and checked with `cmp`. The reviewers re-ran those checks
  independently.
- `cargo nextest run --workspace`: 6703 passed, 0 failed, 13 skipped.
- `cargo clippy -p agaric --all-targets`, `SQLX_OFFLINE=true cargo check
  --workspace --all-targets` and `cargo fmt -- --check` are clean.
- Per-item vitest runs are green, and `npm run typecheck` is clean.
