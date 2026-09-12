# Session 1728 — `get_link_metadata` joins the conformance differential (#3830)

Refs #3830. The `get_link_metadata` read waiver ("link_metadata cache
outside the conformance snapshot scope") is lifted the way #4995 lifted
the attachment reads: a fixture `seed.link_metadata` section puts the
same rows on both stacks and `query_link_metadata.json` drives the read
through it. `NOT_YET_PINNED_READ` 14 to 13.

- Backend: the seed rows go into `link_metadata` verbatim (the two flags
  as `0`/`1`, as `link_metadata::upsert` writes them); the projection is
  one token per row, head the url, attributes `title, favicon_url,
  description, fetched_at, auth_required, not_found`; `None` projects to
  no rows, the same shape as `get_property_def`'s miss. The write-sweep
  denominator moves 44 to 45 with the sweep recorded (`get_cached` is one
  `SELECT`; the writer, `upsert`, is reached only by `fetch_link_metadata`,
  which is not a read arm).
- Mock: a `linkMetadata` map in `seed.ts`, cleared with the rest of the
  mock state; `get_link_metadata` reads it and `fetch_link_metadata`
  upserts its stub into it. The mock test that pinned the old
  stub-for-any-url answer is replaced by a miss-is-null test and a
  fetch-then-get test.
- Fixture urls carry no `#`, `->` or `S<digits>` substring, since the
  token grammar refuses the first two and arg expansion rewrites the
  third.

## Divergences the steps found

One: the mock answered a hard-coded stub (`Mock Title`, fetched now,
neither flag set) for any url and never `null`, where the backend answers
`None` for an unseen url and the stored row for a seen one.
`fetch_link_metadata` stays waived: it is a network fetch plus an upsert,
not a read.

## Verified

`npm run typecheck` clean; `npx vitest run src/lib/tauri-mock/__tests__/
src/lib/__tests__/tauri-mock.test.ts src/hooks/__tests__/useLinkPreview.test.ts`
46 files, 1173 passed; oxlint and oxfmt clean on every changed file;
`cargo fmt --all -- --check` clean; `cargo nextest run --workspace` 6318
passed, 13 skipped; doc-tests green; `conformance_fixtures_match_backend`
passes without `CONFORMANCE_UPDATE`, and update mode left the other 52
fixtures byte-identical. The reviewer checked the seed insert against
migrations 0026, 0067 and 0074 and the binds against `link_metadata::upsert`,
that every mock reset path runs through `seedBlocks()`, and that no e2e
spec depends on the old stub. Falsified on copies: the mock answering the
old stub on a miss reddened the `query_link_metadata` fixture case and the
new miss-is-null mock test; `title` and `favicon_url` swapped in the
backend projection reddened `conformance_fixtures_match_backend`; the
reviewer independently bound `not_found` as `0` in the seed and reddened
the same test on the `not_found=true` row. All restored, `cmp` clean.
