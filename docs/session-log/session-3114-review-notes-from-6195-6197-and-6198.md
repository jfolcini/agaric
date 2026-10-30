# Session 3114 — Review notes from #6195, #6197 and #6198

The follow-up PR for the review notes left on three merged PRs.

**`selectEditorRange` counts the block's own text** (#6198 note, pre-existing).
- The helper's text walk counted text inside `contenteditable="false"` elements: the list marker, markdown-reveal's revealed markers, and a chip's label. So a non-zero offset in a bulleted block landed one character early. In a block with revealed markers, the offset depended on whether the markers had been drawn yet.
- The walk now rejects text under `closest('[contenteditable="false"]')`. ProseMirror still gets the right position, because `posAtDOM` maps the real text nodes; only the counting changed.
- **Callers:**
  - Three `markdown-reveal.spec.ts` calls had counted revealed `**` markers. They now count own text, and each lands where it did before.
  - Two "right to left: the markers shift the offsets" comments became false and were deleted.
  - No caller selects across a chip.
- **Red:** the new "Bold marks the selected word of a bulleted block, past its list marker" case (`selection-bubble.spec.ts`).
  - With the filter turned off, `<strong>` read ` worl` instead of `world`.
  - The case re-reads the saved content after reopening the page.

**`PagePaste` is configured at its one site** (#6197 note). The one-caller `pagePaste()` wrapper is gone, matching how page mode's other extensions are configured.

**A page-lists test title says what it asserts** (#6195 note): "… stays off with no later undo".

**Dropped, with the reason:**
- **The `logger.warn` in `pasteWithStyles` when the pasted block count and style count differ** (#6197 note). That mismatch is the documented paste over whole blocks, which gives no style by design. A warning would fire on ordinary use.
- **The remaining #6197 and #6190 paste divergences:** HTML lists, the first line after text, and plain multi-line text. They are recorded on #6190 (comment 6512560820), and the MCP read format is #6190 step 3.

**Suites:**
- Every Playwright spec that calls `selectEditorRange` (14 files, 155 tests). The lane selector says the whole lane, and CI runs it.
- `src/editor/page-mode` vitest, typecheck, lint, and the manual-stage hooks.
