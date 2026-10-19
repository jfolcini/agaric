# Session 2705 — page mode's block menu (#5972)

Right-click on a block in page mode used to open the webview's menu. `PageBlockMenu.tsx` now listens for `contextmenu` (and the menu key / Shift+F10) on the document, resolves the block under the pointer from `data-page-block-id` (or `posAtCoords` in the margins), and opens the existing `BlockContextMenu` on it, with `selectedBlockIds` taken from the text selection when it spans blocks and holds that block.

Decisions:
- The structural rows (indent, dedent, move up/down, duplicate, merge, delete) are document commands by id (`page-block-actions.ts`; `indentIds`/`outdentIds` are `page-keys.ts`' Tab commands with the blocks named instead of read from the selection). Task, priority, properties and history reuse the session's `afterSave` actions, so a save in flight lands first.
- Over a multi-block selection the menu loops its action over every selected id; each structural row therefore runs once on the selection's roots (`once`), because per-id indent/dedent/move would double-apply or reorder.
- Native menu stays only for a right click on text selected inside one block. A selection across blocks gets the bulk menu (its Copy selection is the copy path).
- Left out: Turn into (no document edit for it yet, #5743), Collapse, Zoom in, drag moves. Duplicate copies text, not task state or properties (same as copy-paste in page mode).
- Trap: the React Compiler memoised `pageStore.getState().blocksById.get(id)` read during render, so a second menu on the same block showed the old task state. The row is read in the event handler and kept in the open-menu state.
- A menu row's action returning a promise keeps the menu open until it settles (`handleAction` awaits), so specs wait for the menu to close before the next right click.

Suites: vitest `src/editor/page-mode`, Playwright `e2e/page-mode-block-menu.spec.ts`, `e2e-tauri/page-mode-block-menu.e2e.ts` (see the PR for whether it ran).
