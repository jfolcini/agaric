# Session 2298 — References sort: no internal keys, a direction toggle, sortable types only

#5683: the References sort offered keys like `is_space` and
`personal_to_work_migration_v1`, had no direction control, and the maintainer
asked that their own properties be offered only when their type has a
meaningful order.

**The keys.**
- `is_space` marks a space's page; the space setup and migrations 0035 and
  0039 write it.
- `personal_to_work_migration_v1` was written once by a migration removed in
  #4132 and survives on old installs' Personal space page, with no
  definition. It is reported, not migrated.

The same leak covered `accent_color`, `template`, `journal-template`,
`listStyle` and three image keys. None were in `INTERNAL_PROPERTY_KEYS`, which
has no Rust mirror.

**Where they leaked:**
- the References sort and add-filter lists (linked and unlinked);
- the property value and `::` key pickers;
- search `prop:` autocomplete;
- the add-property lists in the block drawer and the page property table;
- the query builder and query-table columns.

**One rule.** `INTERNAL_PROPERTY_KEYS` now lists them and is applied at the key
cache and at the three definition-based lists. Beside it,
`isSortablePropertyType` admits:
- number, by value;
- date;
- select, A–Z by option text, because the backend cannot sort by option
  order.

It leaves out:
- text, which the backend sorts by bytes, so "Zed" precedes "apple";
- url, ref and boolean, which have no useful order;
- properties without a definition, which count as text.

**Design.** A field picker joined to an arrow button that shows and flips the
direction. Built-in fields (Created, Due date, Scheduled, Priority,
Completed) come first, then "Your properties". The default is Created,
oldest first, which the backend already used, and the arrow works from the
start. Both controls are 44 px on touch. Sorting orders blocks within each
source page; the pages stay alphabetical.

**Bugs fixed on the way:**
- Sorting by due date, scheduled date or priority did nothing. A reserved key
  never has a `block_properties` row (migration 0088), so the backend now
  orders by its own `blocks` column; the spliced name is one of the fixed
  `RESERVED_PROPERTY_KEYS` literals.
- Number and date properties sorted as text.
- Each sort change dropped keyboard focus.
- The mock ignored sort; `query_backlinks_grouped_sort` pins it to the
  backend.

**Not done:**
- select by option order, which needs a backend change;
- a direction toggle for the Agenda and the Pages browser, whose paging
  assumes a fixed direction;
- a space's own page property table still shows `is_space`.

Gates: vitest (96 files, 2,559), `npm run typecheck`, oxlint, oxfmt,
Playwright (174/174 at `--repeat-each=3`, plus related specs), the Rust sort
tests (12/12) with a backend-authored fixture, clippy and rustfmt. Eleven
vitest mutations, the Rust test, the fixture and three Playwright tests each
went red first.
