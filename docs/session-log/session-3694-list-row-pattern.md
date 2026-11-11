# Session 3694 — One row for every table-like list

The maintainer found the Pages list's rows odd on mobile: each row read as its own rounded card, and the rows sat too close. A survey of every table-like list at phone and desktop width, light and dark, found three row styles for one kind of list:
- a bordered card per row (Trash, History);
- borderless rows floating in 8px gaps (Tags, and Properties on a phone);
- flat rows whose hover or cursor fill was a `rounded-lg` lozenge (Pages, Templates, Search).

- Sources:
  - Apple's HIG on lists and tables: rows suit scanning, and a navigation list persistently highlights its selected row.
  - UIKit's `separatorInset` and Material Web's `inset-start` divider: separators are inset to the content.
  - M3's standard (divided) and segmented (gapped) list variants.
- Variants: four were rendered on the mock by injecting each as a stylesheet into the running app. They were flat full-width dividers, flat dividers inset to the text column, inset gapped rows, and a grouped card. The screenshots went to the maintainer, who picked inset dividers.
- `listRowVariants` (`src/components/ui/list-item.tsx`), with `density` and `interactive`, is now the row of every such list, and `ListItem` is built on it:
  - Rows sit flush. A hairline inset to the text column (the `list-row` utility) separates them, and the last row draws none.
  - Hover and cursor fills take `--radius-sm`.
  - `list-cursor` adds a 2px `--ring` edge bar, so the cursor row holds in dark and high contrast.
  - Rows are at least 44px on a coarse pointer.
- Applied to Pages (flat and tree rows), Trash, History, Search results, the agenda and journal block rows, and through `ListItem` to Tags, Templates, Properties and projected entries. Trash and History lose their card per row.
- Measured row heights went from 40/36px to 44/44px on Pages (desktop/phone), which is now exactly `PAGE_ROW_HEIGHT`. Trash went from 86 to 72px and History from 78 to 64px on desktop. Trash's and History's estimates follow. History's and Tags' virtualizer `gap: 8` goes, and Tags keeps its 40px estimate, which `measureElement` corrects.
- From #6462's review: in selection mode a phone row shows its checkbox cell again. The namespace tree now steps in by that cell (`page-tree-gutter-phone-select`), so a top-level page no longer reads as a child.
- Tests:
  - `list-rows-phone.spec.ts` (iPhone 13): Pages, History and Tags rows are flush and at least 44px. It went red on the old rows (36px Pages rows, 8px gaps in History and Tags).
  - A selection-mode case in `pages-namespace-indent.spec.ts` went red with the tree 56px left of the flat rows.
  - Vitest pins the `ListItem` chrome and the card-free Trash and History rows. Each went red with the card chrome restored.
