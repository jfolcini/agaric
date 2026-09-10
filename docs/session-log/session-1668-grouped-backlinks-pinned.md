# Session 1668 — the two grouped backlink readers, pinned

#4667's criterion 2 had two commands left, and the maintainer's status comment
named their blocker exactly: `list_backlinks_grouped` and
`list_unlinked_references` answer under `groups[].blocks`, and the harness's
one grouped projector binds `run_advanced_query`'s `key`/`count`/`members`
bucket. Pointed at a `BacklinkGroup` it emitted `<missing-key>#count=null` and
dropped every member. So this is a projection extension first and a fixture
second.

## The projection

`backlink_groups_result` in `conformance_query.rs` and `backlinkGroupTokens`
in the TS twin, byte-identical grammar: one
`<page_id>#page_title=…#truncated=…` head per group, one `<page_id>-><block
token>` per member with the usual `BLOCK_ATTRS`, `->(none)` for a group served
empty, and a `filtered#count=…#truncated=…` trailer for the two envelope
scalars `RawResult` has no slot for. Every field of `BacklinkGroup` is bound;
`page_title` because it is the group sort key, which is the decision the mock
had wrong.

Both twins have grammar tests on the same three inputs, and the TS side has a
call-site test through `runQuerySteps` so the projector is not a grammar nobody
wires.

## What the fixture found

`query_backlinks_grouped.json` seeds one block per backend decision and every
one of them was red against the mock on the first run:

- groups were keyed by `parent_id`, not the root page — a nested source landed
  in a group named after its parent block;
- groups were listed in insertion order; the backend sorts by `(page_title,
  page_id)` and the fixture's "Alpha" page is created after its "Zulu" page;
- a source on the target's own page was served; the backend drops it as a
  self-reference, from the groups and from both counts;
- `limit` and `cursor` were ignored; the backend pages over groups with
  `Cursor::for_group`, and answers both counts as 0 on a cursor page (#2201
  item 1b), which the UI is built against;
- per-group `truncated` was omitted; the wire always carries it.

The two handlers were near-copies and are now one `groupedBacklinkResponse`,
which also means `list_unlinked_references` honours `filters` where before it
ignored them. Not pinned, and said so in the fixture: `filters`, `sort`, and
the space filter.

## Bookkeeping

Both waivers are gone from `READ_NO_QUERY_ALLOWLIST` and both names from
`NOT_YET_PINNED_READ`; the shrink-only ratchet is what makes that deletion
mean something. `SWEPT_ARM_COUNT` is 35 with its reason line: both readers are
COUNT and SELECT round-trips, the unlinked one over the FTS index it never
rebuilds.

## Verified

- `CONFORMANCE_UPDATE=1 cargo nextest run -E 'test(conformance_fixtures_match_backend)'`
  authored the fixture; a second pass after the seed-loader fix moved
  `B4.page_id` from `B3` to `B2` and no other fixture's `expected`.
- Rust: `conformance_fixtures_match_backend`, the three
  `backlink_group_token_tests`, `the_write_sweep_denominator_still_matches` —
  5 passed.
- TS: `conformance.test.ts`, `conformance-coverage.test.ts`,
  `conformance-query-backlink-groups.test.ts`, `conformance-query-groups.test.ts`
  — 4 files, 113 passed. `npm run typecheck` clean.
- Falsified against copies, each restored and `cmp`-verified. TS: grouping by
  `parent_id` again, omitting per-group `truncated`, recounting on a cursor
  page, and dropping `page_title` from the projector head — every one reddened
  `conformance.test.ts` on `query_backlinks_grouped`. Rust: reverting the
  seed-loader root resolution reddened the snapshot leg on `B4.page_id`;
  dropping the trailer reddened all three grammar tests.
- Not run locally: the full vitest and nextest suites (CI carries them; the
  laptop is in use).
