# Session 4494 — Graph, Templates and Trash in the sidebar, and Pages rows that start at the card's edge

Part of the #7040 UI review, item D2.

**What shipped**

- **The sidebar's lower group (maintainer decision 13).** Graph, Templates and Trash leave the Pages header (and its ⋮ menu on a phone) for a second sidebar group between the main list and Bookmarks. The phone drawer renders the same sidebar. Tags and Advanced query stay in the Pages header; the palette commands are unchanged. `nav-items.ts` gains `SIDEBAR_LOWER_NAV_ITEMS`.
- **Trash's count follows it.** The badge sits on the sidebar row, named "Trash, N items" in its accessible name and tooltip.
  - The sidebar stays mounted, where the Pages header used to remount on every visit and so recount. `usePollingQuery` takes a `refetchKey`, and `useItemCount` / `useTrashCount` a `recountKey`, so the count refreshes on each view change.
  - Inside Trash the badge now sits beside the list, so a restore or purge must update it at once: `useTrashCount` folds the `['trash', space]` list query's `dataUpdatedAt` into the key, through `useSyncExternalStore` on the query cache. TrashView rewrites that query only after the backend has answered, so the recount reads the new count.
- **Pages rows start at the card's content edge.** The page icon is gone and the checkbox and star follow the title instead of leading it, and the dead `page-tree-gutter` rules are deleted from `index.css`. A namespace root lines up with flat titles and its child steps in. The metadata column has a set width, so a `#tags` chip no longer shifts it.
- The `count_trash` fallback in `src/__tests__/helpers/invoke.ts` is gone: no Pages-view render calls it any more.

**Tests**

- vitest `AppSidebar`: the lower group's rows, the badge's name, the recount on a view change, axe; `PageBrowserHeader` and `PageRow` for the moved controls.
- e2e (mock lane): `pages-header-routes` (the sidebar opens Graph, Templates and Trash; the Pages header has none of them; the phone drawer lists them), `trash-badge` (the badge moves to the sidebar; restoring every item and emptying Trash each clear it at once), `pages-view` and `pages-namespace-indent` (title edge, metadata column, namespace step).
- Shown red on the old sources, and each under one mutation: `refetchKey` dropped from the effect, the badge's name removed, the metadata slot's width removed, a padding on the title cell, Trash back in the header's buttons, a recount key that never changes.
- e2e-tauri: the unused `openTrash` helper is deleted; `openTrashListingAll` opens Trash from the sidebar by its label. Not run here: it needs the native binary.
- **Edited to the new layout:** `smoke`, `trash-badge`, `pages-header-routes`, `phone-view-headers`, `icon-button-sizes`, `pages-keyboard-controls` (the controls now follow the title), `pages-namespace-indent` (the one-level inset is measured from a flat title, 56 px), `helpers.ts`, and `PageRow.test`.
