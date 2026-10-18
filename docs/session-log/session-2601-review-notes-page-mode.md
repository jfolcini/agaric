# Session 2601 — review notes from #5866, #5844, #5837 and #5872

The page-mode notes of the 2026-10-18 handoff (#5882), in one PR.

- **#5866:** page mode's `/attach` of an image only attaches it, as block
  mode's does; paste and drop still insert it inline. `/attach` goes through
  `attachPicked`, which passes no editor to `processFileAttachments`.
- **#5866, not done:** the note said the mock's `add_attachment_with_bytes`
  accepts an unknown block. It does not: it refuses a missing or deleted
  block with the backend's `NotFound` (`persist_attachment` selects the
  active block; there is no foreign-key error), and
  `conformance/fixtures/attachment_add_bytes.json` pins it.
- **#5844:** a query-builder Save refused because the queued change never
  ran shows `error.saveFailed`, as a backend refusal does. Exactly one path
  toasts: the store toasts only when its edit ran and was refused.
- **#5837:** an image's width, alignment or caption written from page mode
  reached the backend but not page mode's held properties, so a redraw
  (Tab) showed the old value until reload. All four writers call the batch
  provider's `invalidate` after a successful write, as `handlePdfSaved`
  already did; block mode pays one extra properties refetch per edit.
- **#5872:** when page mode returns by itself after block-mode deletes bring
  the page under the cap, it takes the cursor from block mode's focused
  block, as the Page switch does, instead of the block from the last switch.

Ran: vitest over page-mode, pages, attachments, editor-toolbar and
block-tree (2815 passed); `e2e/page-mode.spec.ts` (31 passed, two new
scenarios: an image `/attach` that must not inline, and a dragged size
that survives Tab); typecheck and the full lint. Each fix was reverted once
and its test went red on the predicted assertion; the drag-resize writer
is covered only by the e2e.
