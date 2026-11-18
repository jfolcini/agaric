# Session 4330: bulk pages and the facet page through real commands

Stage 0, gap G4b of #6926 (#6529).

**Gap:** the Pages specs got their extra pages from mock-only `localStorage` opt-ins (`__mockExtraPages`, `__mockFacetFixture`), which the mock's seed reads before boot. The bridge has no such seed, so those specs could not run there.

**Change:**
- `seedBulkPages(page, n)` and `seedFacetPage(page)` in `e2e/helpers.ts` create the same pages after boot through `create_page_in_space`, `create_block`, `add_tag` and `set_priority`. Both backends answer these commands.
- Bulk pages are created in title order and their children in reverse. So "Bulk Page 001" is the oldest created and the most recently edited, the two orders the mock's fixture gave and the sort tests read.
- `pages-view`, `pages-filter`, `pages-cursor-load-more`, `pages-keyboard-controls`, `pages-reopen` and `pages-scroll-restore` use them.
- The mock's opt-ins stay, because two mock unit tests (`bulk-pages-history-order`, `pages-last-modified-op-log`) seed through them.

**Ran:**
- The six specs on the mock: 70 passed.
- The same specs on the bridge, temporarily listed: 67 passed, 3 failed. These go to the pages area slice:
  - The "Last-edited buckets" and "the six modes reorder the list" tests read the mock seed's backdated ~90-day stamps, a precondition only the mock's seed produces.
  - `pages-reopen` counts 6 list calls where it expects 3.
- Typecheck and `oxlint --type-aware` are clean.
