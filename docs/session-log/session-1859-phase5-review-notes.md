# Session 1859 — #5160 Phase 5: review notes from #5209, #5214, #5215, #5222 and #5224

One PR for the non-blocking notes from the Phase 5 sweep. Each of them is fixed here, or left with what was checked.

**Fixed.**
- **Tab and the indent keys take the block along** (#5224, builder note). In the buffer, Tab, Shift+Tab and the catalog's indentBlock/dedentBlock moved only the lines the selection touched, so a child became its parent's sibling. They now act on each block the selection touches, with its further lines and children, over one range, as the block editor and the block menu do.
  - Dedent does nothing when a touched block is top-level, as the menu's Dedent (#5224 review). Skipping just that block would dedent its own further lines with the rest of the range.
  - A front matter line, in no block, still stands for itself.
- **Ctrl+Enter acts on the caret's block** (#5224, builder note). It cycled the caret's own line, so on a block's second line it did nothing while the toolbar's TODO worked. It now uses the toolbar's `blockAtCursor`.
- **`blockAt` reads from the top** (#5224 review). Walking back to the nearest line shaped like a bullet, it took a `- x` inside a block's fence for a block, so Priority, a date or Turn into wrote into the code. It now walks forward from the front matter, skipping each block's own lines with `ownEnd`, which already tracks fences.
  - To import `blockAt` into the keys, `lineStarts`, `isBlank`, `depthOf`, `frontMatterEnd` and `subtreeEnd` moved, unchanged, from `source-buffer-keys.ts` to `source-buffer-blocks.ts`. Otherwise the two files would import each other.
- **A `((uuid))` to an `id::` its block's own `^id` overrides** (#5214). `logseq_ids` collected every block's `id::`, so a reference to one on a block ending in `^x` was kept, but resolved to nothing and drew no warning. Those `id::` lines are left out now, so the reference is stripped and counted like any reference to no block.
- **Wording:**
  - The `useDebouncedContentCommit` comment that still said a loaded shape is plain text now says a `#name` is a tag either way (#5215).
  - `blurEditors`' docstring says its Escape leaves the block selected (#5209).
  - keyboard.md and editor.md describe the keys as acting on blocks.

**Checked and left.**
- **#5222's `pageIds` note.** The premise doesn't hold. The buffer's page ids are set when it opens, and only the load (before the buffer mounts) and Reload (which remounts it by `key`) change `opened`. Merge and Overwrite close the editor on success and change nothing on failure, and Keep editing only clears the conflict. So no page line the buffer never held can reach it.
- **#5215's two-step undo after blur.** The two edits already undo as one. Both go through the store's `edit`, coalesced by `edit:<blockId>` (`page-blocks-reducers.ts`), and `onNewAction` merges an action with the same key into the top entry (`undo.ts`). The tag created between them is no undo entry.
- **The toolbar's `#` opening its picker only after a letter** (#5224 builder note). That is the block editor's own `#` rule (#5215): a lone `#` isn't a tag, and opening at once would break the rule.

**Verified.**
- vitest over the buffer's keys, blocks, buffer and pickers tests, `PageSourceEditor`, `PageSourceToolbar`, `source-toolbar-parity`, `useDebouncedContentCommit`, `unmount-flush` and `undo`: 370 passed. `npm run typecheck` is clean, and `scripts/check-import-cycles.mjs` reports no cycle.
- Playwright `e2e/page-source-edit.spec.ts`: 20 of 20.
- nextest over the importer, Logseq and block-ref tests (`import::`, `logseq`, `block_ref`): 182 passed.
- Falsification on copies, each restored and `cmp`'d:

  | Mutation | Red |
  |---|---|
  | The keys indent the touched lines only | Tab takes a block's further lines and children |
  | `subtreeEnd` replaced by the block's own end | that test, and Shift+Tab on a further line |
  | The range not widened to the block's line | Shift+Tab on a further line |
  | No top-level guard on Dedent | Shift+Tab leaves a top-level block where it is |
  | Ctrl+Enter on the caret's line | cycles the checkbox of the block on its further line |
  | `blockAt` walks backward again | a fence under a block's text is that block's; the fence-lines test |
  | The forward walk without skipping a block's own lines | the same two |
  | `logseq_ids` keeps an `id::` its block's `^id` overrides | `a_ref_to_an_id_line_an_own_anchor_overrides_is_stripped` |
