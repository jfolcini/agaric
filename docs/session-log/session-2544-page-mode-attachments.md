# Session 2544

Page mode shows a block's attachments. Slice 6 of #5743, after the lists
slice (#5825). A page holding an attachment now opens in page mode; the
`attachments` blocker and `pageMode.blocked.attachments` are gone.

**Design** (`src/editor/page-mode/page-attachments.ts`, `PageBlockMetadata.tsx`):
- Block mode draws an unfocused block's previews with `StaticBlockAttachments`
  and its badge with `BlockMetadataRow`, whose click opens `AttachmentList`
  (rename, delete) under the row. All three read one page-wide
  `listAttachmentsBatch` through `BatchAttachmentsProvider`, mounted by
  `BlockTree`; image size and caption come from `BatchPropertiesProvider`.
- Page mode already read `listAttachmentsBatch` with the properties in
  `readPageFit`, at open and on every reload, to block on it. It now hands the
  rows over instead. `PageAttachments` holds them, as `PageProperties` holds
  properties. No new IPC.
- The `pageBlock` node view's row (`PageBlockMetadata`) draws block mode's three
  components, in block mode's order: previews, then the row with the badge, then
  the list. It mounts through the same `ControlsGate`, so the caret's block
  mounts at once. The row is redrawn only when a block's rows differ field by
  field (`attachmentRowsEqual`, now exported).
- The components keep reading block mode's providers. `BatchAttachmentsContext`
  and `BatchPropertiesContext` are exported, and each row provides them for its
  own block from page mode's read. So the list and the previews ask nothing of
  the backend per block. A delete or rename (`invalidate`) and a PDF saved from
  the viewer read the page again on the save chain.
- An attachment changed elsewhere comes in with the reload's read, outside the
  document and its undo. Page mode also listens on `recordAttachmentInvalidation`:
  an upload, or a history revert, reads the page again.

**Drop and paste.** Until now page mode took no file. A pasted or dropped file
attached nothing, showed no toast and was not prevented: the file was lost
without a word. A Playwright probe confirmed this for both kinds of file
(PNG and text) and both ways in. Block mode's handler, `processFileAttachments`
in `EditableBlock.tsx`, now serves page mode with a small change: it is
exported, and it takes only `editor` and `activeBlockId` from the roving
editor. Page mode's keys plugin claims a paste or drop that carries files, as
block mode's handler does: files go before any text. A paste goes to the
caret's block, and a drop to the block under the pointer.
The upload runs after the save (`afterSave`, `keep`), so a new block exists
first. An image also goes in at the caret, as an inline `attachment:` image,
while the caret is in that block, as block mode does it. A block removed before
its save ran says "Failed to attach file" rather than drop the file.

**`checkFit`.** It ran `readPageFit` when the switch was pointed at, to find
an attachment. Every remaining blocker is in the rows, so that read could find
nothing new. It now only clears a blocker page mode found while open, once the
rows no longer hold it, with no IPC.

**Found on the way.** axe flagged the text preview's size label: `opacity-70`
on muted text, 2.96:1. It is block mode's component. The fade is gone from it,
and from the file chip, which has the same class.

**Tests, each shown red first by a one-command mutation (backup, trap, `! cmp -s`):**
- vitest `PageModeEditor.test.tsx`, an `attachments` describe (its IPC clones,
  as the real one does, so a rename in the mock is not the row page mode holds):
  - Previews and the badge under the text, outside it, and axe. Red:
    `attachmentsOf` empty.
  - The badge opens the list; a rename reaches the backend, the list and the
    preview. A delete leaves the backend, the badge and the previews. Red: a
    no-op `invalidate` (the preview kept `notes.txt`; two previews where one
    was expected).
  - A refused delete and a refused rename toast, and the row stays. Red: the
    toasts dropped from `useBlockAttachments`.
  - A pasted file is attached to the caret's block, a new one too, and shows.
    Red three times: no paste handler, no `afterSave` (the new block did not
    exist yet), and no listener on the invalidation bus.
  - A pasted image goes in at the caret as `![shot.png](attachment:…)`. Red:
    no editor handed over.
  - A refused upload toasts, and nothing is attached. Red: the toast dropped
    from `processFileAttachments`.
  - A file pasted into a new block that is joined away before its save toasts.
    Red: the not-run notice dropped.
  - A paste without files is left alone. Red: the handler claiming it.
  - A peer's attachment added or deleted shows on reload, outside undo. Red:
    no `take` in `bringIn`.
  - The no-redraw test gains an attachment. Red: rows compared by reference.
  - The lazy describe: previews mount only once near, or once the caret is in.
    Red: mounted at once for a block with attachments.
  - The reload blocker test now blocks on a query a peer writes. Red: the
    query check dropped from `blockerIn`.
- `page-mode-fit.test.ts`: attachments are let in and handed over. Red: the
  check back.
- `PageEditor.test.tsx`: the pointed-at attachment read is gone with the read.
  The found-and-removed pair now uses a query page mode found. Pointing at the
  switch clears it with no IPC; red with `checkFit` a no-op. Choosing Page
  clears it too; red without `setFound(null)` in `changeMode`.
- Playwright `page-mode.spec.ts`: a page with an image, a text file and a plain
  block opens in page mode with the previews and the badge. The image opens
  full screen. A text file dropped on the third block is attached and shows.
  Away, back, Page again: all of it is still there, and axe passes.
  `get_batch_properties` is only ever asked for the whole page. Red four
  times: the properties context dropped (a call for one block), no drop handler,
  the previews dropped, and the size label's fade back (`color-contrast`).
- `page-mode-setting.spec.ts`: the attachment case is now an embed, whose
  tooltip says why. Red: the embed check dropped.
- fast-check: not extended. #5721's property drives the save path and the
  commits, not the node view. Page mode writes no attachment through the save
  path, so no step can change an attachment, and `expectBackendHoldsDoc`
  already fails a save that deletes a live block.
- e2e-tauri `page-mode-attachments.e2e.ts`: a task, a property and a text
  attachment set through the real IPC. The page opens in page mode with the
  checkbox, the chip, the badge and the preview read from the bytes on disk.
  The checkbox goes to DOING. Away and back, Page again: all of it is read
  again, and the backend holds DOING. Type-checked only; it runs in CI.

**Measurement.** `AGARIC_PERF=1 AGARIC_PERF_REPEATS=5 e2e/perf.spec.ts -g 'page
mode'`, sizes held to 500, unthrottled, median and band. The harness now gives
every block a text attachment and every tenth an image too. The baseline is the
same build with that seeding skipped. The machine was shared with other
agents' builds and test runs (load average 4 to 35), so runs alternated, five
without and six with, in one session. Page mode:

| Run | Load | Worst frame while opening | Key to paint, p50 |
| --- | --- | --- | --- |
| with | 20–35 | 148 [101–886] ms | 11 [7.1–45] ms |
| without | 9–19 | 98 [90–340] ms | 10 [7.8–11] ms |
| with | 9–12 | 159 [99–370] ms | 10 [8.1–39] ms |
| without | 16–36 | 102 [83–135] ms | 7 [5.7–8] ms |
| with | 7–15 | 101 [76–235] ms | 7.6 [5.8–9.6] ms |
| without | 4–7 | 81 [72–128] ms | 5.9 [5.4–8] ms |
| with | 4–6 | 99 [85–175] ms | 8.6 [5.9–10] ms |
| with | 8–9 | 153 [109–216] ms | 11 [9.7–13] ms |
| without | 9 | 136 [121–182] ms | 9.3 [8.8–9.5] ms |
| without | 8–9 | 92 [69–133] ms | 6.7 [5.3–7.7] ms |
| with | 7–8 | 85 [76–113] ms | 8.7 [5.8–12] ms |

The last slice measured 78 [62–86] ms and 5.6 [5.5–5.9] ms on a quieter
machine. Here even the baseline spread from 5.9 to 10 ms, so a single pair says
little. The opening frame overlaps the baseline's band in every pair. In the
two quietest pairs, key to paint is 2 to 3 ms higher with attachments, with the
bands touching. Block mode rose about 1 ms with the same seeding, at
3.2 → 4.3 and 3.7 → 5.0 ms. So some of the rise is the previews' DOM, not page
mode. A clean A/B needs a quiet machine.

**Gates:** vitest over `src/editor src/stores src/lib` (9,535 tests) and
`src/components`. Under load, three tests outside this change timed out:
`TaggedItemsSection` twice and `UnlinkedReferences.countIntegrity`. All 29 pass
when run alone. Also `npm run typecheck`, `npm run typecheck:e2e`,
`npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri` and `npm run lint`,
with no new warnings. Playwright on a private port: `page-mode`,
`page-mode-setting`, and the attachment specs (`attachments`, `drop-upload`,
`image-lightbox`, `inline-image-1434`, `md-attachment-render-1451`,
`pdf-annotation-1452`, `pdfjs-v6-smoke`, `toolbar-controls`,
`scroll-ipc-counts`, `import-export`). One `page-mode` run under load failed
"arrows move the cursor across blocks" (a 200-block page with no attachment).
It passed three runs alone.
