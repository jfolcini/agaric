# Session 1726 — the attachment reads join the conformance differential (#3830)

Refs #3830. Three of the seventeen read commands still waived from the
conformance `queries` leg shared one reason, "attachments blob store
outside the conformance snapshot scope": `list_attachments`,
`list_attachments_batch` and `read_attachment_meta`. The blob store is
still out of scope; the metadata rows are not. A fixture
`seed.attachments` section puts the same rows on both stacks, the way
#4939's `seed.property_defs` did, and `query_attachments.json` drives the
three commands through it. `NOT_YET_PINNED_READ` 17 to 14.

- Backend: the seed rows go into `attachments` verbatim (eight columns),
  and `conformance_query.rs` projects one token per row, head the
  attachment id, attributes in the column order `block_id, filename,
  mime_type, size_bytes, fs_path, created_at, content_hash`; the batch
  answer reuses the `<block>-><row>` grammar and a requested block with no
  rows is absent, as the backend's `GROUP BY` leaves it. A
  `read_attachment_meta` miss is `NotFound` on the backend, so the miss
  step is an `expect_error`, not a `null`.
- Mock: `conformance-replay.ts` loads the section, `conformance-query.ts`
  wires the three commands, and `rawRows` sorts map entries by raw key so
  both stacks agree on `HashMap` order before relabeling.
- Fixture ids are short (`ATT1`), not ULIDs: the coverage ratchet reads any
  26-character Crockford string in a recorded token as a stack-local leak.

## Divergences the steps found

Four, all fixed in `handlers/attachments.ts` and `seed.ts`:
`list_attachments` and `list_attachments_batch` answered in insertion
order where the backend sorts by `created_at, id`; `read_attachment_meta`
answered `null` on a miss where the backend rejects `not_found`; mock
rows carried no `content_hash` at all. Left alone, outside these steps:
the mock's own constructors stamp `created_at` as an ISO string where the
binding says number, reachable only through `add_attachment_with_bytes`,
which stays waived.

## Verified

`npm run typecheck` clean; `npx vitest run src/lib/tauri-mock/__tests__/
src/lib/__tests__/tauri-mock.test.ts` 45 files, 1148 passed; `cargo nextest
run --workspace` 6318 run, one red: the write-sweep denominator guard
(`the_write_sweep_denominator_still_matches`) counting 44 arms against its
recorded 41, which is the guard doing its job; the sweep for the three new
arms (three `SELECT`s, no writer) is recorded beside `SWEPT_ARM_COUNT` and
the guard is green at 44. `conformance_fixtures_match_backend` passes
without `CONFORMANCE_UPDATE`, and update mode left the other 51 fixtures
byte-identical. Falsified on copies: the mock's listing sorted by `id`
alone reddened the `query_attachments` fixture case on the vitest side; the
batch handler emitting `[]` for a rowless block reddened it again with
`S9->(none)`; the backend seed binding `content_hash` as NULL reddened
`conformance_fixtures_match_backend` with a QUERY mismatch on every row;
the reviewer independently swapped two attributes in the backend
projection and reddened the same test, and showed that removing the
`rawRows` key sort reddens this fixture and no other. All restored, `cmp`
clean.
