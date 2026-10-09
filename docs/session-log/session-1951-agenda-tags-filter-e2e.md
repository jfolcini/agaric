# Session 1951 — e2e: agenda filter builder and tag query modes (#5366)

Two mock-lane scenarios from #5366 whose existing tests stopped at presence
or `aria-pressed`, now asserting the rendered results.

What shipped:

- `e2e/agenda-filter-builder.spec.ts`: the Agenda filter builder narrows the
  list by status, by priority and by tag, alone and combined, and clearing
  brings back all eight seeded tasks. The seed adds its own `errand` tag,
  because the seeded `work`/`personal` tags are also referenced inline and
  the mock does not record inline references. The combined data is chosen so
  dropping any one filter lets another task in.
- `e2e/tags-query-modes.spec.ts`: with two tags selected, AND lists their
  intersection and OR their union, in block-id order (the order
  `query_tag_and_property_boundaries.json` pins); "Include inherited tags"
  adds a tagged page's children and removes them again when turned off.

Verified: red with the priority filter dropped (`src/lib/agenda-filters.ts`),
with AND sent as OR and with the inherited flag forced off
(`TagFilterPanel.tsx`), each on a copy, restored and `cmp`-checked; 18/18
under `--repeat-each=3` with retries off; typecheck, oxlint and oxfmt clean.
