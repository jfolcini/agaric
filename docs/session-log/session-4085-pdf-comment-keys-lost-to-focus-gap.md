# Session 4085 — a PDF comment's keys typed while pdf.js had taken its box out of the page

`main`'s Playwright shard 2 failed once (run 43499854333, commit 2f1c268) in `e2e/pdf-highlight-blocks-6629.spec.ts`, "page mode: Save adds the block, and its chip reopens the reader there": after the second Save the comment "Note" had no block.

## Cause

The spec typed before pdf.js had finished placing the comment box. Not a product defect: a person cannot type inside the window.

On a page that already holds an annotation (here the highlight the first Save wrote), pdf.js sorts a new editor among the others: one zero-delay timer after making the box it removes the box from the document and inserts it again (`AnnotationEditorLayer.moveEditorInDOM`), which drops the focus, and one more timer later it gives the focus back. In between, the dialog's focus trap holds the focus. The spec waited for the box to be focused, which is already true before the move, and typed. Four keys that arrive in the gap go to the dialog. The box is still empty when the Comment tool is switched off, so pdf.js removes it; removing it reports the editing state, which says "not empty" because of the highlight, so Save turns on. Save then writes a copy with no new annotation, and the only block is the highlight's.

Read in `node_modules/pdfjs-dist/build/pdf.mjs` and `web/pdf_viewer.mjs`, then shown: with a temporary in-page event log, and with pdf.js's zero-delay timers stretched from the test, typing while the focus was on the dialog and switching the tool off after it returned gives CI's failure exactly (`['Page two']`, no `'Note'`). It did not occur naturally in 140 local runs of the old spec, CPU throttled and loaded.

A first comment on a page with no other annotation is not moved, so only the tests that reopen an annotated copy were exposed, block mode and page mode alike. Page mode had nothing to do with it.

## Shipped

`pinPdfComment` in `e2e/helpers.ts`, used by this spec and by `e2e/pdf-annotation-1452.spec.ts`, which had the same steps. It waits for two things before typing: the text layer naming the box in `aria-owns`, which pdf.js sets as it places the box, and then the focus. After typing it checks the box holds the words, so a lost key fails there and not three steps later. It also clicks the editor layer once it is in comment mode, not the page: the Comment button shows pressed before pdf.js has finished switching (it first reads the file's annotations back into editors), and with the timers stretched the click landed on the text layer and made no box.

No `e2e-tauri/` spec opens the reader.

## What ran

- With pdf.js's two timers stretched to 100 ms and 400 ms and keys 50 ms apart: the old waits lose keys in the three tests that reopen an annotated copy (`"N"`, `"No"`, `"No"` for `"Note"`); with the new waits all five tests of the spec pass.
- `e2e/pdf-highlight-blocks-6629.spec.ts` with `--repeat-each=40`, four workers: 200 passed. `e2e/pdf-annotation-1452.spec.ts` with `--repeat-each=10`: 40 passed.
- `npm run typecheck`, `npm run lint`, `node --test scripts/e2e-related.test.mjs`, `prek run --hook-stage manual --all-files`.
