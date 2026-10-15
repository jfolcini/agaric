# Session 2108 — Pages: every sort orders the whole space

#5371. With more than 50 pages, the Pages sort menu misled:
- Alphabetical, Created and Recent went to the server as `default` and were
  re-sorted in JS over the 50 loaded rows, so "Created" showed the 50 oldest
  pages newest-first;
- Alphabetical folded ASCII only;
- "Recently modified" read only the page block's own ops, so a body edit did
  not move the page.

What changed:
- **Migration 0123.** `pages_cache` gains `title_sort_key` and `last_edited_ms`.
  The device-local `page_opens` table is `STRICT`, cascades from `blocks` and
  is never synced.
- **Title key.** `agaric_core::title_sort::title_sort_key` is the title
  NFKD-decomposed, marks stripped, lowercased. It is written wherever
  `pages_cache.title` is.
- **Last edited.** Every applied op raises its page's `last_edited_ms`, the
  value only ever going up. The raise runs in the kernel, `BatchApplyOps`,
  `CommandTx` and peer ingest. The rebuild births it from the op log, else the
  ULID time, floored at 1 so a seeded page is not re-selected on every boot.
- **Last opened.** `record_page_open` upserts `opened_ms`; navigation calls it
  where it records a `recent-pages` visit.
- **`PageSort`.** Alphabetical, Created, RecentlyModified, LastOpened,
  MostLinked and MostContent, all keyset-paginated on the server. `Default`
  and the correlated `MAX(op_log.created_at)` subquery are gone, and so are
  the client re-sorts.
- **Frontend.** Every option goes to the server and rows render in the order
  received. A stored `default` reads as `created`, and no saved view is
  dropped. The mock mirrors the key and the sorts, and the conformance
  fixtures pin both sides.
- **MCP.** Main's `list_pages` schema named `default`; it now lists the six
  sorts.

Tests:
- Each sort orders more than one page of results across a cursor, against an
  oracle over the full set. A cursor replayed under another sort returns
  `RequiresRefresh`.
- `pages_cache_parity.rs` pins both keys after single ops, a batch, a
  cross-page move and a delete. The reconciliation oracle checks them too.
- `record_page_open` covers its happy path, a refusal for anything that is not
  a live page, and the purge cascade.
- The boot fills a seeded space page once.

Falsified on copies: TS F1–F9 in the write phase; Rust R1–R9 in the lane.

For the maintainer:
- The three indexes the issue specified were dropped before shipping: the list
  filters by space, which `pages_cache` does not carry, so `EXPLAIN QUERY PLAN`
  drives from `idx_blocks_space_type`, sorts with a temp B-tree, and never
  chose them. The maintainer chose to make index-served sorts work in a
  follow-up: `space_id` on `pages_cache`, `(space_id, key, page_id)` indexes,
  and the query driven from `pages_cache`.
- `page_opens` cascades from `blocks`, so a future `blocks` rebuild must copy
  it aside like the other cascade satellites.
- The `LastEdited` filter still reads the page block's own ops while the sort
  is page-wide. That is the follow-up.
