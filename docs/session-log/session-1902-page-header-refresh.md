# Session 1902 — the page header follows undo, sync, MCP and tag changes (#5287)

This is the next batch of the session that logged 1873, 1882, 1884, 1887
and 1890. That session also drove #5320 to merge after its own session was
archived: it renumbered that PR's log twice, to the number the collision
check assigned (it merged as 1898).

## #5287

- **The bug.** The page header went stale in four ways:
  - Ctrl+Z on a page property toasted "Undid property change", but the
    table kept the new value.
  - A sync or MCP property change, or a template toggle from elsewhere, left
    the table and the template toggle showing the old state. The first
    click on the toggle then wrote a no-op.
  - Renaming or deleting a tag from the tag's own page left the old name on
    the header chips of other pages. A deleted tag was still offered in the
    header's "+" picker, and picking it failed.
  - The header's kebab Undo/Redo reloaded the page but kept every name cache.
    An undone tag chip stayed, and a page the undo had trashed was still
    offered in the `[[` picker.
- **The causes.** `PagePropertyTable` and `usePageTemplateMeta` loaded once
  per page and subscribed to nothing. `useBlockTags` reloads only on the
  name bus's `invalidated` event. A rename from the tag's own page announced
  only a page rename, and a delete only a page removal. The header's
  Undo/Redo handler was a copy of `refreshAfterUndoRedo` without its
  `invalidateNameCaches()`.
- **The fix.**
  - The property table and the template flags refetch on the block-property
    counter (`useBlockPropertyEvents().invalidationKey`). Sync and MCP
    already bump it.
  - `refreshAfterUndoRedo` is exported and bumps that counter too, because
    an undo emits no property event. The header's Undo/Redo goes through it.
  - `persistTitle` drops the name caches when the renamed block is a tag.
    `usePageDeleteAction` drops them when the deleted block is not in
    `affected_page_ids`. The backend lists the deleted block there only
    when it is a page, so a block missing from it is a tag.
  - A refetch keeps this page's unsaved draft rows. A page switch still
    drops them.
- **A race the refetch made reachable.** `PageEditor` is not keyed by page,
  so a property event shortly before a page switch could land the old
  page's rows in the new page's table. Its save handlers would then write
  them to the new page. Both loaders now ignore an answer for a page they
  have already left.

## Review notes from earlier merges

- **#5320.** The reviewer left three non-blocking notes. None changes code:
  - "`emit_with_an_unserializable_payload_logs_instead_of_panicking`
    asserts nothing." It is the only test that would go red if `emit`'s
    default error handler panicked. The `emit_with` test passes its own
    handler.
  - "`emits_and_sends_stay_in_the_callers_trace` needs nextest." That is
    the documented convention, and `lib.rs` already has a test that relies
    on the same process-per-test isolation.
  - "An emit can reach the frontend after the command's reply." The
    reviewer found no frontend code that depends on the order.
- **Correction to 1890.** The MCP `journal_for_date` gap that log called
  "filed separately" is #5314.

## Verified

- **Falsification**, each on a backed-up copy, restored and checked with
  `cmp`. Each break made its test red:
  - dropping `recordBlockPropertyChange()` (the undo test);
  - replacing the draft merge with a plain replace (the draft test);
  - dropping the draft reset on a page change (the page-change test);
  - dropping the three name-cache drops (the three new header tests);
  - dropping `invalidationKey` from the template hook (its test);
  - dropping each stale-answer guard (both page-switch tests).
- **Full vitest (four shards):** 867 files, 20,440 tests passed (51
  skipped, 1 expected fail). `npm run typecheck` exits 0.
