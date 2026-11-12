# Session 3971 — saving PDF annotations works, and keeps the block's link

`Refs #6629` (checkbox 1, the fix half; the highlight-block items wait on the design note there).

Two defects, one behind the other:

- Save in `PdfViewerDialog` had never enabled in the real app. pdf.js sends
  `editingstateschanged` with `isEmpty` under `details`; the listener read it at the top level.
  The unit test dispatched the top-level shape, which pdf.js never sends, so it passed. That one
  payload line in the existing test was corrected to the library's shape.
- With Save working, the annotated copy gets a new attachment id and the original is deleted, so
  an `attachment:<old id>` link in the owning block's text went dead. Save now rewrites those links
  through the page store before deleting the original, and keeps the original when the block's text
  cannot be read or the edit is refused: two files and a working link.

Decisions and traps:

- No backend command replaces an attachment's bytes under the same id, so the id has to change.
- The rewrite goes through the page store so a static block updates at once. Page mode would have
  recovered through its reload after `onSaved`; only the block-mode check made before navigating
  away shows the store route is needed.
- The text it rewrites is read from the backend, not the store: page mode saves through the block
  commands and leaves the store behind, so rewriting the store's copy wrote back over text typed in
  page mode since it opened. Review caught it; the page-mode spec now types first.
- The dialog takes its page store with `usePageBlockStoreApi`: both hosts (`StaticBlock`, page
  mode's `PageBlockMetadata`) render under one, so the no-store branch was test-only and is gone;
  the dialog's existing tests now render under a store too.
- Links to the old id in other blocks are not rewritten: nothing queries block text for attachment
  links. Documented as a limit.
- The rewrite is its own undo entry, so Ctrl+Z after a save restores a link to the deleted
  original. Attachment add and delete return no op refs to group with it.
- An event mock should copy the library's real payload.

Ran: full vitest, typecheck, lint, the prek hooks, and the Playwright specs selected for the diff.
No Rust.
