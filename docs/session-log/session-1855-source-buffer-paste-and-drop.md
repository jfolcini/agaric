# Session 1855 — Edit as Markdown: paste and drag-and-drop keep the right ids (#5160 phase 5-5b)

Paste and drag-and-drop hygiene for the plain-text buffer of 5a, plus a fix to how a cut takes a line's id.

**What changed.**
- **A paste or a drop brings in only this page's ids** (`src/editor/source-buffer.ts`).
  - The buffer is built with the page's line ids as loaded (`sourceBufferExtensions(pageIds)`, from `opened.page.lineIds`), and a pasted or dropped line carrying any other id arrives with none.
  - So lines from another page's buffer are new blocks, and the save no longer warns `line N: not a block of this page`.
  - The set is the page's ids, not the lines the buffer opened with. A line cut, the page left (its draft kept) and reopened, then pasted back, is still a move.
- **Drag and drop is a cut and a paste** (`handleDrop`).
  - A drag inside the buffer (`moved`) deletes the selection in the same transaction, the ids taken as a cut takes them, and pastes the dragged slice at the drop point through the same `pasteLines`. One undo takes the drag back.
  - A drag with `Ctrl` (ProseMirror's copy modifier) leaves the source alone, so the copy is a new block.
  - A drop from outside follows the paste rules: another buffer's lines lose foreign ids, and any other HTML drops as its plain text.
  - 5a's gap is closed: a dragged line kept its text but lost its id, so the save deleted and recreated the block.
- **A cut of only a line's start leaves the line its id** (from #5221's review).
  - Before: a cut that removed a line's start always took its id, so Ctrl+X on `- foo` in `- foo bar` left ` bar` with none. The save deleted the block and recreated it, losing its inbound `((refs))`. Backspace over the same text kept the id.
  - Now a cut takes a line's id only when it removes the line's start with its line break or the rest of its text (`cutIds`). Otherwise the id stays on what remains, and the pasted fragment carries none. Drag uses the same rule.
  - A whole line's text cut without its break still empties the line, so it still moves, as 5a's test pins.
- **e2e.**
  - `e2e-tauri/page-source-paste.e2e.ts` (new) drives the buffer's own cut, copy and paste handlers through a new helper, `pageSourceClipboard`, against the real backend:
    - a line and its child, cut and pasted elsewhere, keep their ids and nesting;
    - a copied line saves as a new block next to the original;
    - lines pasted from another page's buffer save as new blocks with no foreign-id warning, and that page keeps its blocks.
  - `e2e/page-source-edit.spec.ts` gains a paste from Quick Notes's buffer and a mouse drag of a line, both saved and re-read.
- **Docs.** `docs/features/editor.md` and `docs/FEATURE-MAP.md` describe the drag and the paste from another page. The 5a note that such a paste keeps the foreign id and warns is gone.

**Worth knowing:**
- The vitest drags run ProseMirror's own `dragstart` and `drop` handlers on dispatched events. happy-dom has no layout and no `DragEvent`, so each test sends a `MouseEvent` carrying a `DataTransfer` and stubs `view.posAtCoords` to the drop point. Everything after the hit test is real.
- The e2e-tauri clipboard is a stand-in object on a plain `Event`, as `pasteFileIntoFocusedBlock` does, because WebKitGTK may refuse a constructed `ClipboardEvent`. Nothing reaches the system clipboard.
- A drop whose slice is empty (files) is left to ProseMirror and the browser, as before.

**Verified.**
- vitest: `source-buffer` (44), `PageSourceEditor` (59) and the mock's `page-source-apply` (54), 157 passed; `npx vitest run e2e-tauri`, 40 passed. `npm run typecheck`, `tsc -p tsconfig.e2e.json` and `tsc -p tsconfig.wdio.json` are clean, and so is knip.
- Red first: 9 of the 11 new buffer tests and 2 of the 3 new editor tests failed on the code before them. The other three pin behaviour that already held and were seen red under the mutations below: the buffer's reopened-draft paste (F2) and `Ctrl` drag (F8), and the editor's draft paste (F2, F4).
- Playwright: `e2e/page-source-edit.spec.ts`, 13 of 13 with `--workers=2 --retries=0`; the two new cases 10 of 10 with `--repeat-each=5`. Built with F1 and F3 on a copy, both new cases fail: the report lists `line 5: not a block of this page`, and the drag leaves the ids behind.
- e2e-tauri: the new spec typechecks; it was not run here (it needs a native build). It runs in CI.
- Falsification on copies (restored and `cmp`'d), across the 103 buffer and editor tests:

  | Mutation | Red |
  |---|---|
  | F1 a paste keeps foreign ids | 4 |
  | F2 a paste drops every id | 7 |
  | F3 a drop ignores the move | 3 |
  | F4 the loaded set is the opening lines, not the page's | 1 |
  | F5 a drag leaves the id on the line it left | 1 |
  | F6 a cut takes the id on the line's start alone (the old rule) | 4 |
  | F7 a cut takes the id only with the line break (5a's whole-text cut goes red) | 2 |
  | F8 every drop moves, a `Ctrl` drag too | 1 |
