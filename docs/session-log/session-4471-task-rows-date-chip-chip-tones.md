# Session 4471 — one task row, one date chip, and three chip tones

Part of the #7040 UI review, items S6, S2 and S7.

**What shipped**

- **One task row (S6).** The Due panel's Overdue, Scheduled earlier and Upcoming rows, its state groups, and the Agenda all render `BlockListItem`: checkbox, title, then priority and date chips, then the source page. A phone row is two lines; a desktop row is one.
  - `ui/alert-list-row.tsx` and `ui/section-title.tsx` are deleted. `AlertSection` is a `SectionGroupHeader` over `BlockListItem` rows, with the Overdue heading in the error colour.
  - Overdue and Upcoming rows are now interactive like every other task row: tag chips, editable date chips, drag-to-reschedule and the touch reschedule button. #4705 kept them inert because the old row was one click target.
  - The Agenda's `priorityVariant` and its hand-rolled priority span are gone.
  - Projected rows keep their content and change order: title, "Projected", priority, date.
  - Virtualized Agenda and Due-panel rows are placed by `top`, not `transform`: a transformed row is a stacking context, so the next row covered the lower half of a chip's 44 px hit area.
- **One date chip (S2).** `common/DateChip.tsx` (`kind`, `date`) on blocks, task rows, projected rows and the Week header counts. `lib/date-icons.ts` holds the one glyph pair, a flag for due and a calendar clock for scheduled, also used by the toolbar, the slash commands and the date fields, which had assigned their glyphs three different ways.
  - Due is red with a solid flag when past, amber today, neutral later. Scheduled is the `date-scheduled` green everywhere.
  - Each chip is named for its kind and date ("Due Nov 25"), since a row with both chips had two buttons named "Edit date".
- **Three chip tones (S7).** `Badge` gains:
  - `tag`, a tint in the tag's colour (`useTagColorStyle`), for tags in text, the page header and the Tags list;
  - `property`, outlined, for property chips, `+N`, tag properties and page aliases;
  - `metadata`, plain muted text, for type labels and counts, including Settings › Properties' type, use count and Built-in.
  - Chips use `touch-hit-area` instead of painting the 44 px target.

**False premises in the issue**

- The phone no longer put the checkbox above the title (#7052). Rows were still 90 px in the Due panel and 74 px in the Agenda, from a 44 px reschedule button and painted touch chips.
- The DOING row's blue bar was the keyboard cursor, which #7085 stopped painting at rest.
- History's op types have their own colours; they are not the grey chip.

**Not done**

- The Done panel keeps its completed icon rather than a checkbox, which would add an un-complete control.
- `QueryResultList`'s task row, and task state on Search and References rows.
- Chips left alone: the Pages row flags, `FilterPill`, the query token badges, batch and trash counts, `AggregateSummary`, `GraphFilterBar`, Templates and History badges.

**Tests**

- e2e `task-rows-chips` (mock lane): phone row heights in the Due panel and the Agenda, no card on Overdue rows, chips after the title on desktop, the glyph pair, and the chip tones. Each was red on main.
- vitest: `DateChip`, `badge`'s chip vocabulary, and new cases in `BlockListItem`, `AlertSection`, `DaySection`, `DuePanel` and `PageTagSection`. `theme-contrast` checks the scheduled chip, the Overdue heading, and scheduled against due-today and overdue.
- Each was shown red by a mutation, sixteen in all: for example the glyphs swapped, chips before the title, a card back on Overdue rows, rows back on `transform`, and the reschedule button back on `touch-target`.
- The UI review tour shoots the Tags view's colour picker (#7092), with its custom section open.
