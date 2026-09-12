# Session 1730 — the page-alias reads join the conformance differential (#3830)

Refs #3830. `get_page_aliases`, `list_page_aliases_by_prefix` and
`resolve_page_by_alias` leave the read waiver list ("page-alias table
outside the conformance snapshot scope") the way the last three slices
lifted theirs: a `seed.page_aliases` section on both stacks and
`query_page_aliases.json` driving the three reads through it.
`NOT_YET_PINNED_READ` 11 to 8.

- Backend: the seed rows go into `page_aliases` verbatim, `page_id`
  through the seed label map; `get_page_aliases` projects one bare token
  per alias (the `list_property_keys` shape), and the two tuple-shaped
  answers project through a `tuple_token` helper, element 0 the head (the
  page id, which relabels through the canonical map) and the rest named
  attributes, because a Rust tuple crosses the wire as a JSON array with
  no key to hang the `id` shape on. The write-sweep denominator moves 47
  to 50 with the sweep recorded (three `SELECT`s; the writer is
  `set_page_aliases`, not a read arm).
- Fixture: four pages, seven aliases whose lengths and spellings
  discriminate the by-prefix order and the substring match, a case-variant
  pair for `COLLATE NOCASE`, a `limit` below the match count, a
  `delete_block` op so a tombstoned aliased page must miss, a resolve miss
  and a page with no aliases. A second space is not expressible in a
  fixture (every seed block is stamped into the test space), so `Global`
  and the active scope are pinned on the same data and the description
  says so.
- Mock: the TS token grammar gains the `tuple` kind; the seed loader
  appends aliases per page.

## Divergences the steps found

Two, fixed in `handlers/pages.ts`: `resolve_page_by_alias` served a
tombstoned page where the backend joins live rows only; `get_page_aliases`
answered insertion order where the backend orders by alias under `NOCASE`,
so a case-folding comparator now orders it and the by-prefix secondary key
too. One more aligned by inspection, not by a step: both scoped readers
filtered on the retired `block_properties(key='space')` row instead of
`blocks.space_id` (the #3081 class; `create_page_in_space` was the one
mock path that never stamped the column and now does). The mock
dual-writes both, so no fixture can tell them apart, and the reviewer
showed the reverted read stays green.

## Verified

`npm run typecheck` clean; `npx vitest run src/lib/tauri-mock/__tests__/
src/lib/__tests__/tauri-mock.test.ts` 45 files, 1159 passed, plus the ten
alias-touching component and hook files (637 passed); oxlint and oxfmt
clean; `cargo fmt --check` clean; the migration-mock contract guard green
(its self-test reds on this branch's inherited first commit and is fixed
on #4998, which this branch rebases onto); `cargo nextest run
--workspace` 6318 passed, 13 skipped; doc-tests green;
`conformance_fixtures_match_backend` passes without `CONFORMANCE_UPDATE`,
and update mode left the sibling fixtures byte-identical. The reviewer
checked the seed insert against migrations 0015, 0061 and 0089, the three
arms against the command wrappers' args and scope handling, the tuple
projection's zip on both sides, the by-prefix `ORDER BY length(alias),
alias` mirror, and the `limit` cap. Falsified on copies: the by-prefix
sort flipped alphabetical-first reddened the `query_page_aliases` fixture
case; resolve made case-sensitive reddened it on the folded step; the
backend seed lowercasing aliases reddened
`conformance_fixtures_match_backend`; the reviewer independently dropped
the tombstone skip, replaced the fold with byte order, and broke the
active-scope key, each reddening the fixture case. All restored, `cmp`
clean.
