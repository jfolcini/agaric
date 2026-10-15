# Session 2079 — Backlink panels: count the collapsed unlinked panel in SQL

#5422 asked whether the two backlink panels do more work than they show.
Stage 0 added two report-only problem-tier probes to `interactive_slo`.
The first is the collapsed unlinked panel (`list_unlinked_references` with a
limit of 1) on a title mentioned past the 10,000-row FTS cap. The second is
the linked panel (`list_backlinks_grouped`, limit 50) on a target with 5,000
backlinks spread over 100 pages. Their seeders give every block a `page_id`
and an `fts_blocks` row. `seed_blocks_bulk` sets neither, and the older
`backlink_query_bench` seeder makes orphans, so it only times the FTS scan.

The collapsed panel shows only a count. To get it, the list path pulled up to
10,001 FTS hits into Rust, resolved their root pages and grouped them. The new
read command `count_unlinked_references` runs the same capped FTS window,
taken from the SQL shared with the list path (`unlinked_fts_hits_sql`), and
counts it in one statement. `ROW_NUMBER() <= FTS_ROW_CAP` keeps the rows the
list path keeps. The root-page join drops orphans and self-references, the
same rows `unlinked_total_count` drops.

`useUnlinkedReferences` calls the count while the panel is collapsed and
unfiltered. With filters on, it keeps the limit-1 list call. The list path
stays live as the oracle: store tests assert that the count equals the list
path's `total_count` and `truncated` on these fixtures:
- plain matches;
- linked sources;
- matches on the target's own page;
- orphans;
- aliases;
- the space filter;
- exactly and past the cap;
- zero matches.

The mock handler derives its count from the list handler, and a conformance
query step pins both. The linked panel now moves its fetched rows into their
groups instead of cloning them, since a block has one root page.

Left out on purpose:
- **Group pagination in SQL for the linked panel:** it already exists.
- **Deriving `total_count` from the group query:** it counts only the first
  page, before filters.
- **A per-group member cap in SQL:** it is exact only for the creation sort,
  and no measurement shows the member fetch dominating.
- **A green-tier budget for either probe:** that waits for CI numbers.

Suites run:
- the `count_unlinked_references_`, `backlink` and conformance nextest
  subsets, with the count tests shown red against mutated copies of the count
  statement;
- vitest on the hook, both panel components and the tauri mock;
- clippy and `cargo doc` with the CI lint flags across the workspace, after
  merging `main`;
- the `bench-slo` lane on this branch with the problem tier enabled.
