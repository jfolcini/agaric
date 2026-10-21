# Session 2829 — Turn into in page mode's block menu; the journal views stay in blocks

Two small page-mode items from the #5691 review of 2026-10-21.

- **Turn into in the block menu.** Page mode's block menu (right click, or the gutter grip) never showed Turn into: nothing filtered it out, `PageBlockMenu.tsx` just never passed `onTurnInto` to `BlockContextMenu`. The header comment and the parity waiver said page mode lacked the document edit and pointed at #5743, which is closed; page mode's slash menu has run Turn into since #5866.
  - The menu now maps each Turn into row to the slash menu's own item (`TURN_INTO_COMMANDS`, `CALLOUT_COMMANDS`) and runs it through the same after-save path. `PageModeEditor`'s slash `command` body became `runAfterSave`, which both use, so there is one implementation.
  - The row for the block's current type is read from the document, not the store, because the store lags typed text.
  - The stale comment, the waiver in `page-mode-surface-parity.test.tsx` and the `editor.md` sentence are gone.
- **Journal views.** The daily, weekly and stream views mount `BlockTree` directly and stay in blocks whatever *Edit pages as* says; the monthly view is a calendar with no editor. `editor.md` § Page mode and `journal-and-agenda.md` now say so.

- **Review.** The menu's Turn into row shows its chord, which page mode never bound, so `PageKeys` now opens the slash picker on Turn into for the caret's block when the catalog's `turnIntoBlock` chord is pressed (`Ctrl+Shift+L` since #6022). Running a menu item through `runSlashCommand` also recorded `turn-*` and `callout-*` in the slash menu's five recent commands, which the Recent band never shows, so a few conversions pushed out the user's real recents; `runSlashCommand` now records only ids in `SLASH_COMMANDS`, which also fixes typing `/turn h1`. Tests added for typing before a conversion, a new block's list style, a collapsed block, a selection across blocks and keyboard-only use of the menu.

Left as it is: a callout picked from the menu keeps a leftover list style, as the slash `callout` commands and the toolbar's callout button do in block mode; block mode's own menu clears it.

Suites run: vitest over `PageBlockMenu`, the surface parity test and `PageModeEditor`, typecheck, lint, oxfmt, and Playwright `page-mode-block-menu` and `turn-into*`. The new tests were shown red by unhooking `onTurnInto`, dropping the current-type row and making the action a no-op.
