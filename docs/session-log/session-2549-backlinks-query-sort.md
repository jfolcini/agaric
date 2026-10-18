# Session 2549 — a backlinks query sorts its referrers and loads the rest (#5736)

#5736's last-but-one Tags & links item: an inline `{{query}}` of type backlinks,
sorted and paged. A new test in `e2e/query-blocks.spec.ts` drives it on the mock
lane.

**What the spec does:** it seeds more referrers to one page than a query page
holds (`seedSearchBlocks`; the query has no page-size param, `PAGE_SIZE` in
`useQueryExecution.ts` is fixed), types `{{query type:backlinks … table:true}}`
into another page, and asserts:
- the first page in the default order, marked "first … loaded";
- the Content header's `aria-sort` going none → ascending → descending, with the
  rows following;
- Load more bringing every referrer in sorted order, the button gone and the
  partial marker dropped;
- after leaving and reopening the page, every loaded referrer back in the default
  order with the sort reset.

Odd-numbered referrers are created before even ones, so the default order (newest
id first) differs from content order and an append-without-resort after Load more
shows.

**Premise corrections:** sort exists only in table mode (`table:true`), and it
sorts the rows loaded so far, which the header already says ("loaded rows only").

**Shown red:** `compareValues` returning 0 in `useQuerySorting.ts` (the sorted-rows
assertion) and `handleLoadMore` never fetching in `useQueryExecution.ts` (the
all-referrers assertion); the reviewer re-ran the second with the guard inverted.
