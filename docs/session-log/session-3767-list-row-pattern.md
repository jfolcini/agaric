# Session 3767 — One card for every table-like list

The maintainer found the Pages list's rows odd on mobile: each row read as its own rounded card, and the rows sat too close. A survey of every table-like list at phone and desktop width, light and dark, found three row styles for one kind of list:
- a bordered card per row (Trash, History);
- borderless rows floating in 8px gaps (Tags, and Properties on a phone);
- flat rows whose hover or cursor fill was a `rounded-lg` lozenge (Pages, Templates, Search).

- Sources:
  - Apple's HIG on lists and tables: rows suit scanning; a navigation list persistently highlights its selected row; the grouped style separates groups by headers and space.
  - UIKit's `separatorInset` and Material Web's `inset-start` divider.
  - M3's standard (divided) and segmented (gapped) list variants.
- Variants: four were rendered on the mock by injecting each as a stylesheet into the running app, then the two finalists were built. The maintainer picked the grouped card.
- The pattern lives in `src/components/ui/list-item.tsx`:
  - `listCardVariants` is the one card a list sits in. It goes on the list's scroll container, only while the list has rows, never per row.
  - `listRowVariants` (with `density` and `interactive`) is the row, and `ListItem` is built on it. Rows inside the card sit flush and square, a full-width hairline (`list-row`) separates them, and the last row draws none against the card border. Rows are at least 44px on a coarse pointer.
  - `listHeaderVariants` makes a section header the card's own header row. That is the one rule for Pages' section headers and Agenda's groups. Search makes each page group its own card, with the group header as its header row. The maintainer compared that with one card around all groups and kept a card per group, since each group collapses on its own. The page title keeps the foreground colour at the row size: the header classes now merge through `cn()`, where concatenation had let the header's muted `text-xs` win.
  - `list-cursor` adds a 2px `--ring` edge bar.
- Applied to Pages, Trash, History, Search results, Agenda, Tags, Templates and Properties. A list nested inside another panel, like the journal day's Due / Scheduled panels, keeps the rows without the card, so a day does not stack boxes. The Pages namespace tree continues the same card, since it is sorted among the pages. Trash and History lose their card per row.
- Measured row heights went from 40/36px to 44/44px on Pages (desktop/phone), which is now exactly `PAGE_ROW_HEIGHT`. Trash went from 86 to 72px and History from 78 to 64px on desktop. Trash's and History's estimates follow, History's and Tags' virtualizer `gap: 8` goes, and Tags keeps its 40px estimate, which `measureElement` corrects.
- From #6462's review: in selection mode a phone row shows its checkbox cell again. The namespace tree now steps in by that cell (`page-tree-gutter-phone-select`).
- Tests:
  - `list-rows-phone.spec.ts` (iPhone 13): Pages, History and Tags rows are flush and at least 44px, and a list is one 1px-bordered, 8px-radius card whose last row draws no divider. It went red on the old rows: 36px rows, 8px gaps, and no card border.
  - A selection-mode case in `pages-namespace-indent.spec.ts` went red with the tree 56px off.
  - Vitest pins the `ListItem`, card and header chrome and the card-free Trash and History rows. Each went red when its chrome was mutated.
  - A `SearchResultGroups` case pins a card per group with the title in the foreground colour. It went red with the old class concatenation.
