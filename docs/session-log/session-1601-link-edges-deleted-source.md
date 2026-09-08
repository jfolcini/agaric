# Session 1601 — block_links keeps a tombstoned source; the mock did not (#4848)

## The divergence

`DeleteBlock` enqueues no `ReindexBlockLinks`, so the backend keeps a
soft-deleted source's `block_links` row and filters with `b.deleted_at IS NULL`
at read time. `deriveLinkEdges` skipped deleted sources outright, so the row was
simply absent from the mock's projection of the table.

The conformance snapshot compares that raw table, which is where it showed. It
was found while writing `query_backlinks.json` for #4667 criterion 2, and filed
rather than fixed because closing it needs the read-time predicate somewhere.

## One predicate, not two

The issue said two counting consumers would each need a filter —
`handlers/pages.ts:222` and `handlers/search.ts:2148`. That is the wrong shape.
In both, `edges` has exactly one reader: `buildPageMetaRow(b, descendants,
edges)`, which funnels into `pageLinkStats`. The predicate went there, beside
the same-page/self/orphan-source exclusions it belongs with — the same clause
list `recompute_all_pages_cache_counts`
(`src-tauri/agaric-store/src/cache/pages.rs:139`) spells.

A fifth call site the issue did not name, `link-scan-parity.test.ts:105`, is a
test oracle; its `expectedSources` needed the same read-time filter, because it
models what a reader sees rather than what the table holds.

## The coverage this unblocks

`get_backlinks`' own `b.deleted_at IS NULL` join filter was unpinned, because
pinning it needs exactly the state that tripped the bug. The fixture now seeds
`S8`, links it at `[[S1]]`, and deletes it.

That the filter really was unpinned is the differential, not an assertion:
removing it from the mock's `get_backlinks` against the PRE-#4848 fixture leaves
70 tests passing; against the new one it reddens three steps with
`+ "B8#…#deleted_at=DELETED"`.

The deleted block is a NEW seed, not a re-used `S5`. Deleting `S5` would have
made its absence from the listing true for two reasons and killed the existing
"edge dropped on unlink" pin.

## What is NOT pinned, and why no test was added for it

`run_advanced_query`'s inbound count is unreachable from the backend's own
surface: `QUERY_ALLOWED_KEYS`
(`src-tauri/agaric-store/src/query/projection.rs:48`) excludes `orphan` /
`stub` / `has-no-inbound-links`, and no query-surface sort column reads the
count, so the backend rejects every request that would read what the mock
computes there. Removing the `pageLinkStats` filter reddens exactly one test in
18,966 — the `list_pages_with_metadata` one. That leg is covered only by sharing
the one implementation.

Adding a test to pin mock behaviour for a request the backend refuses would pin
the mock to itself. Recorded instead.

## Falsification

Each against a copy, restored and `cmp`-verified.

- Restore the `deleted_at` skip in `deriveLinkEdges` → the snapshot leg reds,
  `- "source_id": "B8"` missing from `page_links`.
- Delete the `pageLinkStats` line → `expected 1 to be +0` on the new
  `list_pages_with_metadata` test, alone in the full suite.
- Remove the mock `get_backlinks` join filter → three query steps gain B8.
- Remove the `delete_block` premise → both legs red.

## Fixture churn

`CONFORMANCE_UPDATE=1` rewrote 32 fixtures; 31 were whitespace-only, verified by
parsed-JSON equality against a pre-run backup and restored byte-for-byte. Same
trap as session 1598 — worth expecting every time this flow runs.
