# Session 2842 — Ctrl+hover on a page link previews the page

Part of #5691's Obsidian parity: Obsidian's Page preview. Block refs already peeked; page links now preview too.

- **Ctrl/Cmd+hover on a `[[page]]` chip** previews the page: its title and first top-level blocks, read through `listBlocks({ parentId })` under the named cap `listBlocksLimit(5)`.
  - It works in block mode, page mode and the journal.
  - A plain hover and touch open nothing.
  - The page payload sits next to the existing block-ref one in `BlockRefPeek`; `useBlockRefPeek` decides the kind from the chip.
- **The modifier waits the dwell.** Pressing Ctrl with the pointer already on a chip opens the preview after the same 350 ms as a hover; Ctrl auto-repeat is ignored.
- **A Ctrl shortcut typed with the pointer on a link previews nothing.** Any other key cancels a pending open and closes the preview, before the editor consumes its own chords. So Ctrl+B, Ctrl+← or Ctrl+E no longer flash one.
- **A Ctrl+click that opens a new tab closes the preview.** The click listener moved from the container's capture phase to `window`'s, so a capture handler above the page that stops the click does not leave a stale preview over the new tab.

Reviewed separately; the reviewer was killed by a container restart and continued by a second one.
- **Accessibility.** The preview has an accessible name with a fallback ("Page preview"), takes no focus on hover, and passes axe.
- **Rejection path.** It is tested.
- **Left as is.** A Ctrl-held drag selection that crosses a chip can open a preview.

Shown red:
- the modifier check removed;
- every peek treated as a block ref;
- the click listener back on the container;
- the auto-repeat check dropped;
- the chord cancel dropped (the e2e too);
- the `isConnected` guard dropped.

Suites run:
- vitest over the hook, the component, `src/components/journal` and `src/components/pages` (1254 passed);
- typecheck and lint;
- the 175 Playwright specs `just e2e-related` selects. The four that fail here also fail on `origin/main` in this container: `block-line-break` iPhone "New line" and three `diagram-legibility`.

`e2e/page-link-preview.spec.ts` also covers a Ctrl+click on a previewed link opening a new tab, which needs #6041.

The possible flake in `page-mode.spec.ts` ("the first switch of a session… keep the block at the top") passed 10 of 10 under load and was not reproduced.
