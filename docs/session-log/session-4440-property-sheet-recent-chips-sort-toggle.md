# Session 4440 — A property's one sheet, recent-page chips and the sort toggle at the buttons' height

**Ask.** The maintainer's fourth pass over the UI review (#7040), after #7067 merged:

- The recents strip's chips (*Product Roadmap Q1*) stood taller than the buttons.
- References' sort direction toggle was larger than the Sort select joined to it.
- In Settings › Properties on a phone, a property's use count wrapped alone under its name; it belongs on one line with *Edit options*.
- Then: does a property need its own *Edit options* button? Consolidate further. The maintainer picked one sheet per property, opened by its row.
- The report left out most screenshots.

**Shipped.**
- **Recent-page chips.** On a coarse pointer a chip paints the buttons' 36 px with a 14 px label, and takes up to 192 px so that label fits; the rest of the 44 px target is `touch-hit-area`, inside the strip's padding. The strip is 8 px shorter.
- **Sort toggle.** It paints the joined select's 36 px on touch, with an invisible 44 px target.
- **The property sheet** (`PropertyDefinitionSheet`).
  - A user property's row is one button: its name stretched over the row, with a chevron at the right; the unfit-values badge sits above it.
  - Tapping it opens a dialog, or a bottom sheet on a phone, holding the Name, the type with *Change type…*, a select's options inline, *Merge into another property…*, *Copy to another space…* and *Delete property*. Name and options save together.
  - A written type change, merge or delete closes the sheet too, back to the list that shows it.
  - The sheet takes focus when it opens, not its Name: a phone's keyboard would cover it, and a keystroke meant for the options would replace the selected name.
  - `RenamePropertyDefinition` and `EditSelectOptions` are gone. Merge, Change type and Copy take their trigger from the sheet.
  - Every row is one line again, so the use-count wrap from earlier in this round went with the row's buttons.
  - Built-in rows are as they were.
- **Scheduled earlier** (review of #7067). It left out tasks due today or in the deadline warning window, which other sections list, and reads every page of `list_unfinished_tasks`, as the Unfinished tasks section it replaced did.
- **The report** keeps every changed pair's images; the last one carried 220 of 382 as text only.

**Ran.**
- `npm run typecheck`, oxlint, and vitest on the properties, i18n, filters, layout, UI primitives and Due panel suites.
- Playwright on the mock: `phone-touch-targets`, `mobile-overflow`, `recent-pages-strip`, `icon-button-sizes`, `page-header-select-options`, and the bridge specs `properties-system`, `properties-table-and-refusals`, `property-def-undo`, `property-key-rename`, `property-type-change`, `property-unfit-marks` and `property-unfit-values` as local copies on the mock.
- **Shown red:**
  - the chip and sort-toggle heights, with the old sizes;
  - the scheduled-earlier filter, with tasks due today let through, and its paging, with one page read;
  - the row's tap target, with the stretched button removed;
  - the delete confirmation's focus, with the sheet taking focus back to the row;
  - the sheet closing after a type change, with it left open;
  - the sheet's focus on open, with the Name taking it.
