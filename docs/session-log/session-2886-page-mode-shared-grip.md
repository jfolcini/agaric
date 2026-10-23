# Session 2886 — page mode draws one grip that follows the pointer, not a grip on every block

#5691, the 500-block cap. After #6083, the largest per-keystroke cost left in page mode on WebKitGTK was the opacity-0 grip button inside every block. Hiding every gutter took a 1000-block page from 39–42 to 27–30 ms per key. `visibility: hidden` removed most of the cost. Positioning, the transition and `contain` changed nothing. So the fix stops drawing a grip per block.

**Design (`src/editor/page-mode/page-gutter.ts`).**
- `PageGrip` is one element per editor. It is a sibling of `view.dom`, so it adds no node to the editable tree.
- One `pointermove` on the editor, throttled to a frame, places the grip at the block under the pointer. The grip hides when the pointer leaves, a document change lands, or a drag or menu ends.
- Dragging reuses `page-drag.ts` with the grip's block. A click opens the same block menu through a `page-grip-menu` event.
- The chevron stays per parent block. The gutter div now exists only on parents.
- The block's `::before` lane is wider, and a capture-phase mousedown keeps a press in the lane from moving the caret.
- `GUTTER_BUTTON_LOOK` is split out of `GUTTER_BUTTON_BASE`, so the grip shares block mode's look without its per-row layout.

**Keyboard.** The grip is no longer a tab stop. A keyboard user loses nothing:
- the menu key and Shift+F10 open the block menu at the caret's block, and a focused chevron opens it at its own block;
- Ctrl+Shift+↑/↓ and Tab / Shift+Tab move blocks;
- the old grip's only key action was Enter for the menu, since drag is pointer-only.

Before, Tab walked through one hidden stop per block, and each stop only opened a menu the caret already reaches. axe finds no violations on a page or the Daily view in page mode.

**The grip no longer shows at rest on the caret's block,** as block mode's does through `.block-active`. Keeping it there means re-placing it after every keystroke, which is the per-key layout this change removes.

**Measured** on WebKitGTK with `scripts/measure-page-mode-webkit.mjs`, 3 repeats, median [min–max], ms. "Before" is #6083's tree. Long frames are counted while scrolling.

| Blocks | Page key p50, before | Page key p50, after | Page INP, after | Block mode INP | Page long frames | Block mode long frames |
|---|---|---|---|---|---|---|
| 500 | 29 [27–31] | 20 [19–21] | 24 [24–48] | 40 [32–40] | 0 | 76 |
| 1000 | 45 [43–46] | 28 [25–29] | 40 [32–40] | 48 [40–56] | 1 | 336 |
| 2000 | 77 [76–82] | 49 [44–63] | 80 [72–80] | 48 [48–56] | 74 | 842 |
| 3000 | 119 [119–122] | 64 [60–67] | 80 [72–80] | 56 [40–64] | 164 | 1269 |

Review re-ran 1000 blocks in one process and got page 29 [29–32] key p50 and INP 40 [40–80], against block mode's 40 [32–40].

**The cap stays at 500 in this PR.** The numbers support 1000: INP inside block mode's range and far fewer long frames. At 2000, page mode's INP is above block mode's. The raise is its own PR.

**Review found and fixed:**
- **The grip stayed in place while its block moved without a document change,** for example on a window resize. `follow` re-placed it only when the pointer reached another block. It now measures the block on every pointer frame, and re-tags it only when the block changes. A unit test pins it.
- **The harness timed out on its second repeat,** because since #6077 the journal opens in page mode once the mode is set. It now resets the edit mode before each repeat.
- **The grip's `data-editor-portal` was dropped.** The grip never takes focus: it has `tabindex=-1`, its mousedown is prevented, and the menu hands focus back to the editor. And `useEditorBlur` never runs beside page mode: the Daily view is the only journal surface in page mode, and an embed inside page mode mounts no roving editor.

**Shown red,** each with a one-command mutation that restored the file:
- the grip appended into the block: the "one for the editor, outside its root" unit test fails;
- the drag reading the first block instead of the grip's: the e2e drag test sees no dragging class;
- the lane mousedown handler removed: the e2e click test sees the caret moved;
- `follow` re-placing only on a new block: the new unit test reads the old offset.

**Suites:**
- vitest: `src/editor` 3702 passed; `src/components/block-tree`, `src/components/editor` and `src/__tests__` 3235 passed;
- typecheck, lint, and the import-cycle check;
- Playwright: every `page-mode*` spec, `journal-page-mode`, every `block-dnd*` spec and `journal-block-controls`, 110 passed.
