# Session 2858 — code highlighting re-highlights only the blocks an edit touches

This session closes #5691's checklist item "No plugin scans the whole document on every transaction".

**Lowlight was a real whole-document walk.** Stock `@tiptap/extension-code-block-lowlight` (`dist/index.js`):
- calls `findChildren` on the old and new document on every transaction, selection moves included;
- re-highlights every code block whenever an edit touches one, or the number of code blocks changes.

In page mode's whole-page document, that cost lands on every keystroke.

**The replacement is `codeHighlightPlugin`** (`src/editor/extensions/code-highlight.ts`). `CodeBlockWithShortcut` installs it in place of the stock plugin, by dropping the plugin whose key starts with `lowlight$`; the install test fails if that key changes upstream. Block mode and page mode share it through `contentExtensions`. What it does:
- **Selection-only transactions:** returns the decoration set as it is.
- **Edits:** maps every colour through the edit and collects each text block the changed ranges touch. It drops those blocks' old colours and re-highlights only the ones that are code blocks.
- **Paragraph-like blocks are collected too.** Two edits turn code into a paragraph: `toggleCodeBlock` (and Turn into a paragraph) and a Backspace join onto the paragraph above. In both, the mapped colours would otherwise stay on text that is no longer code. The review caught this.
- **Colours match stock:** same lowlight output, language choice and class joining.

**The list layout was left as it is.** `PageLists.layout` reads only the top-level blocks' `blockId` and `depth`, and only when the document changed. It never descends into a block. Limiting it to the changed ranges would be wrong: `depth` and `blockId` are written with `setNodeAttribute`, whose step has an empty step map, so the ordinals would go stale.

**Shown red:**
- the stock plugin restored: all 4 tests;
- re-highlighting every block on each change;
- dropping the colour mapping;
- never re-highlighting touched blocks;
- the stale-colour case against the first version of the plugin, for both the toggle and the join.

**Suites run:**
- vitest over `src/editor`, `src/__tests__`, `src/components/editor` and `src/components/editor-toolbar`: 5555 passed;
- typecheck and lint;
- Playwright over the code-block, slash-command, mobile-editor and page-mode specs: 133 passed.
