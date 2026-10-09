# Session 1953 — e2e: property table, refused inline values, select options (#5365)

Three mock-lane property scenarios from #5365, each asserting stored state
re-read after reopening the page.

What shipped (`e2e/properties-table-and-refusals.spec.ts`):

- A `key:: value` line the backend refuses (a select value outside its
  options) stays as text, one toast names it, and no property is stored.
- The page header's Properties table: add a property from a definition,
  create a definition, edit, delete; each survives reopening the page.
- Editing a select definition's options changes what the chip's editor
  offers; deleting a definition still in use is refused and leaves it and
  the block's value in place.

Bugs it found, filed rather than fixed here:

- #5448 (data loss): Escape on a new block whose only text is a
  `key:: value` line deletes the block; the property commit and the
  empty-block cleanup race. Pinned in this spec as `test.fail`.
- #5449: text and select chips show `[[…]]` placeholders, select
  definitions likely can't be created, the in-use delete hides its reason,
  and a `property-picker` blur test passes without blurring.

Verified: each scenario went red with the code it covers broken (strip the
line on a refused write, a double toast, delete or create only on screen,
two of three options offered, a row removed before the backend answers),
each on a copy, restored and `cmp`-checked; 15/15 under `--repeat-each=3`;
typecheck, oxlint and oxfmt clean.
