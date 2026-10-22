# Session 2850 — tabs reorder and close on middle-click, and a page dragged into the editor becomes a link

These are #5691's Obsidian parity items for the tab strip and drag-to-link.

## What changed

- **Middle-click closes a tab.** It reuses `delegatedMiddleClickProps`.
- **Tabs reorder by dragging.** This uses dnd-kit with the same sensors as bookmarks; the shared setup moved into `layout/reorder-dnd.ts`.
  - **Keyboard:** Space picks the tab up, ←/→ move it, Space drops it, and Escape puts it back. While a tab is held, the arrows move it instead of switching tabs.
  - **Persistence:** the new order is saved through `moveTab` in the existing tabs store, and the active tab stays active.
- **Dragging a page into the editor inserts `[[link]]`.** A bookmark or a recent-page chip can be dropped into block mode, page mode or Edit as Markdown.
  - **Block mode:** the link goes at the end of the block. The editor has already left the block when the drop lands.
  - **Other surfaces:** where an editor holds the block (page mode, Edit as Markdown, the focused block), the link goes in at the drop point.
  - **Recent-page chips:** they set the page id plus `text/plain` `[[ULID]]`, which Edit as Markdown reads. Recents are the only source that opts in, through `NewTabTarget`'s `dragsPage`.
  - **Bookmarks:** they reach the editor through `dropPageAt`, because dnd-kit owns their pointer.
- **Bookmark rows drag vertically only.** Dragged sideways, they made dnd-kit scroll the sidebar without end.

## Review

A separate review:
- **Narrowed dragging.** It made dragging opt-in. The build had made every `NewTabTarget` draggable, which took text selection away from search snippets and reference previews.
- **Removed a sleep.** An e2e spec now waits for dnd-kit's announcement instead.
- **Simplified `dropPageAt`.** Its return value is dropped.
- **Refused drops on whole-block content.** A page dropped on a code, Mermaid, display-math, table or rule block is refused, by checking the block's parsed shape. Appending ` [[id]]` would have broken the fence.

**The same bug in an open editor:** a drop inside a code block that the editor holds is refused too. Without that guard, the drop split the code block and moved the rest of the code out of it.

## Shown red

- `moveTab` placing the active index by position, not by identity;
- middle-click props removed;
- the arrow guard while a tab is held;
- drop handlers on the static block;
- the drop point ignored;
- `NewTabTarget` always draggable;
- recents not opting in;
- the parsed-shape check accepting everything;
- the code-block guard removed;
- Playwright with the middle-click close removed, with no order written on drop, with Space not picking a tab up, with the bookmark drag-out removed, and with no `text/plain` on the drag.

## Suites run

- vitest: about 9,450 tests over the changed areas, the editor and `src/__tests__`;
- typecheck, lint, and `prek` (including the manual stage);
- 235 Playwright tests over tabs, drag, bookmarks, recents, page mode, references, search, the Pages view and the page tree.
