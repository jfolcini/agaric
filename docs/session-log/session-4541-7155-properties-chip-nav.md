# Session 4541 — #7155 R13, R21: a page's Properties open from a chip; Graph and Trash move to the sidebar's foot

Round 2 of the UI review (#7155): decisions D5 and D6.

**What shipped**

- **R13: a Properties chip.**
  - A page's in-place "Properties N" collapsible under the tags row is gone. A "Properties N" chip ends the tags row and opens the page's properties: a dialog on desktop, a bottom sheet on a phone (`useDialogOrSheet`).
  - `PagePropertyTable` is now `{pageId, open, onOpenChange}`, without its collapsible header or `forceExpanded`.
  - A page with no properties shows no chip. The page ⋮ menu's "Add property" became "Properties…", opening the same surface either way.
  - The surface focuses itself on open, not the first value: on a phone a focused value raises the keyboard over the sheet, and on desktop the next key replaced the value.
  - Nothing opens it through a Radix trigger, so it gives focus back to its opener on close, or to the ⋮ when the opening menu row is gone (`returnFocusRef`).
- **R21: Graph and Trash move to the foot.**
  - The sidebar and phone drawer list Journal, Agenda, Pages, Search and Tags, then Bookmarks. Graph and Trash sit in a `mt-auto` group at the foot of the scrolling list, just above Sync and Settings.
  - They stay in the list, not the footer: a four-row footer squeezed the list to nothing at maximum zoom.
  - `SidebarContent`'s viewport became a full-height flex column so `mt-auto` works.
  - Templates left the navigation. Settings › General gained "Template pages · Open templates", and `navigateToView('Templates')` in the e2e helpers goes through it. `/template` and new-page-from-template are unchanged.

**Tests**

- New: `page-properties-chip.spec.ts` (desktop and phone) and the chip and ⋮ flows in `PageHeader.test`. Also the Templates row in `GeneralTab.test` and the lower group in `AppSidebar.test`.
- `pages-header-routes.spec.ts` (bridge) was rewritten for the new order and the Graph/Trash group's gap above Sync. Edited assertions pinned the collapsible, the "Add property" label and Templates in the sidebar.
- The builder and the reviewer each showed every new test red, including the reviewer's focus-on-open and focus-return tests.
- The reviewer built the bridge and ran 20 specs (149 passed), plus 11 mock specs (60 passed).
- Left as notes: adding a first property from ⋮ takes one more click than the old auto-opened picker. Focus after a property's delete confirmation lands on `<body>`, as before.
