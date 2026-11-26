# Session 4499 — one menu row, the page menu in sections with Export, and a pointer-opened menu without a ring

Part of the #7040 UI review, items O6, M4 and M5 (maintainer decision 21).

**What shipped**

- **The page ⋮ in sections (O6).** Add (alias, tag, property, emoji), View (outline, history, graph, open in new tab), Template, and Edit (undo, redo, edit mode, Edit as Markdown, move to space), each a named `role="group"`. Copy app link, Export as Markdown, Save as Markdown file and Print sit under one Export row: it opens in place on a desktop and drills in on a phone sheet, with a Back row, and focus follows the drill. Delete page sits alone at the bottom. The menu opens on Add alias.
- **One menu row (M4).** `ui/menu-row.tsx`'s `menuRowVariants` (CVA) draws the page menu, `PopoverMenuItem`, the block menu, `ContextMenuItem`, the journal day's mode row and the palette's action menu: one pressed fill, a 44 px row on a coarse pointer, an inset ring, an `indent` and an `active` axis. `MenuRowChevron` draws every disclosure, replacing the ▸/▾ characters.
- **Icons (M5)** are 16 px, 20 px on a coarse pointer, set by the row at zero specificity; the per-call 14 px pins are gone.
- **No ring on a pointer open.** The block menu tracks the last input, as Radix does: opened by keyboard it focuses its first row; opened by pointer it focuses itself, and the first arrow, Home or End enters at the first or last row. Chromium kept keyboard focus mode through a right-click, so a right-click after any key drew the first row's ring.

**False premises in the issue**

- The page menu was already split into six groups by rules; what was missing was decision 21's grouping and the Export submenu.
- `ContextMenuItem` had no pressed fill: #7052 left it alone. It has one now through the shared row.

**Left as they are**

- `PageBrowserHeader` and `SavedViewsDropdown` still pin 14 px icons on their rows (open PR #7119 owns the first).
- "Export ▸ Export as Markdown" says Export twice; renaming the row is a separate copy change.

**Tests**

- vitest: new `menu-row`; PageHeaderMenu "sections" and "sections on a phone"; BlockContextMenu "opening focus" (pointer, keyboard, a modifier pressed first, entry at the first and last row).
- e2e (mock lane): new `menu-sections` — Export in place on a desktop; the phone drill and Back with a copy-link round trip; a 20 px icon on a coarse pointer; no ring on a right-click after typing; Shift+F10 focuses the first row with its ring.
- e2e (bridge): `page-kebab`, `import-export` and `block-paste-outline` reach their rows through Export: 44 passed.
- Shown red on the old code and each under one mutation: a section mislabelled, Export open at start, Delete inside a group, no phone drill, a pinned icon, the pressed fill, the coarse icon size, the indent, the chevron, each caller off the row, the pointer open focusing a row, a modifier entering the rows.
- **Edited to the new menu:** item counts 14 → 13 and 15 → 14; the first focused row copyAppLink → Add alias; copy-link, Markdown, save-file and print paths open Export first; the history row follows Open outline; ArrowUp from Delete lands on Export; indents `pl-7`/`pl-12` → `pl-8`/`pl-14`; BlockContextMenu's `beforeEach` opens from the keyboard; `phone-bottom-sheets` proves the menu by Add alias; e2e-tauri's `pageAction` takes a submenu.
