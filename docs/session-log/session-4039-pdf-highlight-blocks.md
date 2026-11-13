# Session 4039 — A PDF highlight becomes a block under the PDF's block

Third checkbox of #6629 (first slice), continued in a cloud session from the overnight batch's parked `wip:` commit (#6667).

**What it does.** Saving highlights in the PDF reader adds one child block, under the block that owns the PDF, for each new highlight: the passage is its text, and `pdf_attachment`, `pdf_page` and `pdf_boxes` (PDF units, compact JSON) record where it came from. All three are internal keys, in `INTERNAL_PROPERTY_KEYS` and in Rust's `op.rs`, and the Markdown export and mirror leave them out. A source chip ("report.pdf · p. 2") on such a block opens the reader at that page. A highlight on a PDF opened with no owning block is refused, as Save already was.

**Decisions and traps.**

- The blocks are made on *Save*, not when the highlight is finished. pdf.js's `reporttelemetry` `added` event also fires for annotations already in the file when the editor layer is re-enabled, and a highlight undone in the reader, or a reader closed unsaved, would leave orphan blocks. Save reads the new highlights from `annotationStorage.serializable`, skipping any that already have an id. This departs from the design note's "when a highlight is finished"; it is recorded on the issue.
- Highlights stay written into the file (maintainer, 2026-11-13), so Save writes a new attachment. It re-points every `pdf_attachment` in the space to the new id, after the link rewrite (#6646), and deletes the original only once every re-point has succeeded. Any failure leaves both files, so every reference still resolves.
- A highlight block moved to another space is not re-pointed, and dangles after the next Save.
- One undo entry takes the new blocks back, and leaves the PDF as it is.

**Tests.** vitest: `pdf-highlights` (specs, re-point pagination), `PdfViewerDialog` (blocks on Save, refusal with no owner, the re-point, its failure keeping the original), `PdfSourceChip` (page, rejection path, axe). `e2e/pdf-highlight-blocks-6629.spec.ts` covers block and page mode and undo, re-queried after navigating away and back. Rust: the page buffer hides the three keys and a buffer save keeps them.

**Falsified.** Dropping the re-point, creating the block without its parent, opening the chip at page 1, and dropping the undo entry each reddened the predicted unit and e2e assertions.

**Ran.** vitest (five files), typecheck, lint, the PDF and attachment Playwright specs, the Rust test, clippy.
