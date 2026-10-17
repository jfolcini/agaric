# Session 2478 — search and Advanced Query happy paths (#5738)

Mock-lane specs for #5738's Search and Advanced Query items.

**`e2e/search-happy-paths.spec.ts`:**
- **Enter commits the search.** The clock is installed before boot and
  paused, so the input's debounce never fires and a result can only come
  from the submit path.
- **A result click** opens its page with a below-the-fold block in view and
  the editor on it.
- **The palette's Toggle sidebar and Keyboard shortcuts** do what they say.
  Nothing else sends their events. The palette's *Create new page* and
  *Toggle theme* already had specs.

**`e2e/advanced-query-happy-paths.spec.ts`:**
- **A nested tree** returns exactly the blocks it selects: NOT state DONE,
  and an Any group of two tags. A positive control first shows both blocks
  the tree must drop.
- **A full-text term** narrows the total, and a priority sort orders seeded
  rows whose relevance ties.

**Corrections to the issue:**
- **Advanced Query has no Run button:** results re-run on every edit.
- **There is no due-date sort,** so priority stands in.
- **The theme** is a class on `<html>`, not a `data-theme` attribute.

**Not covered here:**
- **Advanced Query group-by and aggregates:** the mock returns a synthetic
  group and stub aggregates, so they move to the real lane.
- **Advanced Query saved views:** a saved view is never listed, a product bug
  being verified on the real backend.
- **Search page chips:** they hit a bug, adding or removing a chip does not
  re-run the search, which is fixed in its own PR.

**Shown red:**
- **Enter:** the Enter path broken and the debounce kept. Review checked that
  a running clock then turns it green, so the paused clock is what keeps the
  debounce out. The reverse mutation stays green.
- **The result click:** the block id dropped from navigation.
- **The palette commands:** each event name broken.
- **The tree:** the `Not` wrapper dropped, and the group forced to `And`.
- **The controls bar:** the sort key never sent, and the full-text term never
  sent.

**Ran:**
- both files with `--repeat-each=3`;
- `npm run typecheck`, oxlint and oxfmt.
