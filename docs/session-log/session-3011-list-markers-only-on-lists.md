# Session 3011 — A list marker shows only on a list block (#5691)

Set out to apply the maintainer's rule: "Bullets are only for unordered list blocks, not for any other block, either in Block or page mode" (and numbers only for numbered ones).

**Shipped.** One predicate decides whether a block shows its marker, in every mode: `showsListMarker` / `contentShowsListMarker` in `list-style.ts`. A block whose text opens with anything but a plain paragraph (heading, code, quote, callout, table, divider, query, embed) shows no marker, whatever `listStyle` it stores. It drives:
- the static block;
- the roving editor's marker decoration and list keys;
- page mode's node view;
- the Edit as Markdown preview.

Typed input rules, dividers, tables, queries, embeds and paste had all leaked a bullet onto such blocks.

**Leaving the list:** a list block whose text this device stops opening with a paragraph has its style cleared.
- **Block mode** clears it in the page store's `edit`, after `edit_block` succeeds, in its own `try`. A refused edit keeps the style, and a failed clear is logged but does not roll back the saved text. A `load()` (sync, undo, restore) clears nothing.
- **Page mode** clears it from `page-lists`' `onTransaction` and skips `REMOTE_PATCH` transactions, so a receiving device writes no op.

**Decisions and traps:**
- **The first write side was too broad.** It was an `EditableBlock` effect on any content change, so refused-edit rollbacks lost the style and receiving devices wrote ops. Review moved it into the store and onto local transactions.
- **A stored style is kept on a heading,** and only its marker is hidden. Edit as Markdown can still carry `listStyle` on any block. The style is dropped only when this device edits a list block out of being a paragraph.
- **Existing tests changed by the rule:** `page-mode.spec.ts`, `ListMarker.test.tsx`, `markdown-reveal.test.ts` and `page-mode-reveal-lists.test.tsx` had asserted a marker on a heading. They now assert none, or use a link's brackets where the heading stood in for "markup before the marker".
- **One stub:** `page-blocks.split-indent.test.ts` gained a `delete_property` stub. The split's first half turns a paragraph into a heading, so the store now makes that call. Deleting an absent key appends no op (`delete_property_absent_key.json`).
- **Left as it was:** the Preview's own ordinals loop. Replacing it with `computeListOrdinals` grouped differently when an indent level is skipped, so the refactor was reverted and the Preview's use of the rule got its own test.

**Suites, after the rebase onto the page-mode toolbar, look and bubbles:**
- vitest over `src/editor`, `src/components/editor`, `src/components/pages`, `src/components/editor-toolbar`, `src/stores` and `src/lib` (13,361 tests);
- typecheck and lint;
- Playwright: the new `list-marker-only-lists` spec plus `list-style-keyboard`, the page-mode toolbar, look, bubbles and reveal specs, `block-syntax-reveal`, `slash-commands-happy-paths` and `page-source-edit` (62), and `page-mode.spec.ts` (43).
