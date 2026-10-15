# Session 2139 — the Pages "last edited" filter reads the whole page

The Pages `last-edited` filter compiled against the page block's own op
log, while the "Recently modified" sort reads `pages_cache.last_edited_ms`,
the newest edit to any block on the page. A page edited only through its
children sorted first and still fell out of "Edited this week". #5578's
review found it, and `docs/PAGES.md` documented the disagreement as
expected behaviour.

The filter now reads `pc.last_edited_ms`. The shared body moved into
`compile_last_edited_against`, so:

- **Pages** passes the column. `pc` is in scope at every statement its
  output reaches: both FROM shapes and the COUNT.
- **Search** passes the per-block expression it compiled before; its SQL
  and binds are unchanged.
- **The advanced query** delegates to Search instead of Pages. Its rows
  are blocks, and its "Last edited" sort reads the same per-block
  expression, so the filter and the sort still agree there.

The tauri mock's filter dropped its page-only override and reads the
page-wide stamp its sort already read.

Tests:

- `last_edited_rolling_and_older_than_count_a_child_edit` and
  `last_edited_range_reads_the_page_wide_newest_edit` in
  `list_pages_with_metadata_tests.rs`.
- Two query steps in `query_pages_metadata_sorts.json`, Rolling and
  OlderThan under the recently-modified sort. Their `expected` was written
  by hand, derived again by the reviewer from the seed, and matched the
  backend unchanged.
- The pages-filter conformance seeder now raises
  `pages_cache.last_edited_ms` after its raw op-log insert, as every
  production op path does; without it every Range vector would read 0.

Falsified on a copy: restoring the old expression for Pages turns exactly
the two new tests and the conformance check red, with the conformance
check showing the predicted rows (Rolling `[]`, OlderThan all three). The
mock half was falsified the same way against `conformance.test.ts`.

The review found six stale copies of the old behaviour, all fixed here:
the `docs/PAGES.md` paragraph, three docs saying the advanced query
delegates every leaf to Pages, and two cost-hint comments.

Not changed: a page row in the advanced query still reads the page
block's own edits. Giving page rows the page-wide stamp means a lookup
per page row and changing the advanced sort with it.

Ran: the 86 targeted Rust tests, `ts_bindings_up_to_date`, workspace
clippy, `npx vitest run src/lib/tauri-mock` (1133), `npm run typecheck`.
