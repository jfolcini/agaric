# Session 2992 — Page mode gets block mode's formatting toolbar (#5691)

Set out to give page mode a GitLab-style toolbar (#5691, the maintainer's decision of 2026-10-28). Per the maintainer, it reuses the toolbar we already have rather than a new one.

**Shipped:**
- **The toolbar.** Page mode shows block mode's own `FormattingToolbar`, sticky above the document. The plain editor commands already worked on page mode's editor.
- **Block commands.** Turn into, task, priority, dates, properties, query, emoji and divider go through `dispatchBlockCommand`, which targets the global focused block that page mode never sets. The bus therefore gains one focused command target (`registerFocusedCommandTarget`). While page mode's editor is the active one, a block command goes to its caret block through page mode's existing actions, applied to every block the selection touches. With no focused target the bus behaves as before.

**Review:**
- **Bus change.** Every `dispatchBlockCommand` caller fires from a focused editor or its toolbar. Page mode never sits beside a mounted `BlockTree`. The target unregisters on unmount. So block mode is unchanged.
- **Two fixes:**
  - Turn into → Code left a list style on the block. It now clears it through `PageLists`, via an optional `onTurnIntoCode` that block mode does not pass.
  - The task button sets or clears TODO in page mode, while Ctrl+Enter cycles. So it gets its own tooltip, through an optional `tips` map, instead of "TODO cycle (Ctrl+Enter)".
- **Spanish.** No `es` string was added: the `es` catalog translates only the `errors` and `settings` namespaces.

**Traps:**
- The sandbox's Chromium is 141, older than the build Playwright 1.64 expects. A tap there fires `pointerdown` and then `click` with `detail: 0`, so `block-line-break.spec.ts:292` and a sub-pixel `diagram-legibility` check fail locally. Both are green in CI on main.
- The toolbar's tasks button and the Markdown buffer's still act differently. The maintainer has since made Task a list kind (#5691 comment 6467401951), and that PR aligns them.

**Suites:**
- vitest, whole suite: 23,411 passed;
- typecheck and lint;
- `prek run --hook-stage manual --all-files`;
- the Playwright specs `e2e-related` selected: 1,064 passed, plus the 3 local-browser failures above.
