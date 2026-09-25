# Session 1822 — grammar, phase 2b: pasting text into a block

Phase 2b of #5160 (decision D4). Until now only text that opened with a list item reached the block-paste path. Any other multi-line paste became paragraphs, and ProseMirror escaped their markers: `\## Plan`, `1\.`. Every multi-line plain-text paste outside a code block now becomes blocks through the grammar Phase 2a (#5165) gave the three parsers. The paste is spliced in the way a text editor would place it. A single line still pastes inline.

**The splice.**
- `paste_blocks` gains `splice: Option<PasteSplice { before, after }>`, applied in the same `BEGIN IMMEDIATE` transaction as the creates. It adds one edit op and needs no new op type, so the whole paste is one undo step.
- The text before the cursor joins the first pasted block, and the text after it ends the last one.
- When the cursor is at the start of the block, or the block is empty, the first pasted block's task state, list style and properties apply to it.
- Mid-text, the first pasted line joins as the text it was pasted as, markers included: "Hello " + `[ ] Buy milk` gives "Hello [ ] Buy milk", and the block keeps its own type.
- When the last pasted block is fenced code, the text after the cursor becomes its own block, so the closing fence stays a fence.
- The caret lands where the pasted text ends.
- A selection is replaced.
- HTML paste uses the same splice, and it now nests blocks under headings (D16). So a document gives the same tree whether it is pasted as text or HTML, or imported.

**Taking it back.**
- After a paste of two or more blocks, a toast offers **Undo** and **Paste as text**. Both are tappable and keyboard-reachable, and they act only if the paste is still the page's latest undo entry.
- A paste always starts its own undo entry. Typing flushed just before it can no longer merge into the paste, where Undo would have removed it.
- Ctrl/Cmd+Shift+V pastes as plain text directly.

**Found on the way.** After a paste, the tree reloads and unmounts the focused block. That unmount saved the editor's old text as a draft, and the draft landed after the paste, so it overwrote the spliced block. This reproduced against the real backend: `paste_blocks`, then `save_draft` with the old text, then `flush_draft`. The anchor's new text now goes into the store and the editor remounts on it before the reload.

**Review.** An independent reviewer probed the backend splice: names, properties and task state; undo interleaved with the unmount flush; and an over-cap paste, which rolls the anchor edit back. It also checked the draft handling, the toast guard, the chord, and HTML-vs-text parity on one document.
- **A defect, fixed:** pasting inside a heading or quote carried the `## ` or `> ` onto the last pasted block (`Y## here`). The text after the cursor is now taken as a plain paragraph.
- **Four design questions, settled as fixes:** the mid-text literal first line, the fence-safe tail, the paste's own undo entry, and the caret at the join point. Each one's test failed on the code before its fix, and each fix was checked by breaking it again on a copy.

**Worth knowing.**
- A `key:: value` line kept as literal text by a mid-text paste would be read as a property the next time the frontend saves the block. The same is true of any such line typed into a block. Phase 2c's rule, that the blur classifies only what the edit added, closes this.
- Right after a paste, Ctrl+Z inside the editor doesn't undo it, because the remount resets the editor's history. The toast's Undo does, and so does page-level Ctrl+Z after leaving the block.
- The chord is not in the rebindable keyboard catalog.

**Verified.**
- The new routing and HTML tests failed on the old sources (26 of them). The splice tests, the undo test and the caret tests each failed before their fix. 14 frontend mutants and the backend mutants each turned a test red, and every copy was restored and `cmp`-checked.
- The reviewer's full suite passed on the code before the four fixes: `cargo nextest run --workspace` 6538, vitest 19378 (apart from three mock-import tests that 2a had already fixed), and 25 Playwright paste tests.
- After the fixes:
  - the paste, conformance and bindings tests pass (30);
  - clippy and fmt are clean;
  - vitest passes 7155 tests across the editor, block tree, stores, hooks and mock;
  - the paste Playwright specs pass 15 of 15.
- `e2e-tauri/paste-splice.e2e.ts` pastes, undoes from the toast and reads the tree back through the real backend. CI runs it.
