# Session 1679 — the lib tests onto the typed seam

#4668 step 2, fourth directory: `src/lib/__tests__`, the eight files the
backlog listed there. `MIGRATION_BACKLOG` 44 → 36. `ipc-helpers.test.ts`
moved to `DELIBERATE_EXCEPTIONS` instead of leaving: its two remaining hand
stubs drive `read_attachment`, which returns raw bytes with no generated
binding and so is not a key of `CommandReturns`; the reason its backlog
entry already gave now sits on the exception.

## What the seam caught

- `list_trash` items stubbed as `{ id }` where the command answers
  `PageResponse<BlockRow>`: ten missing row fields and `total_count`.
- `create_block` and `search_blocks` rows five fields short of `BlockRow`;
  `log_frontend` resolved `undefined` where it returns `null`.
- Every page literal in `agenda-filters.test.ts` omitted `total_count`;
  `list_tags_by_prefix` rows omitted `updated_at`, and the file's catch-all
  handed that array-returning command a page object.
- Some thirty `list_all_pages_in_space` rows in `export-graph.test.ts` were
  `{ id, content }`; `PageHeading` also carries the four task columns.
- `template-utils.test.ts` stubbed `query_by_property`, `create_blocks_batch`,
  `first_child_for_blocks` and `load_page_subtree` with three-to-five-field
  partials; `get_property` rows omitted `value_bool`.
- `set_property` / `delete_property` resolved `undefined` where they answer
  `WithOps<…>`; inside the seam's documented hole, so not reddening, but a
  shape the backend cannot send.

Order-dependent `…Once` queues became handlers with explicit state where the
order is the subject: the trash cursor chain and the purge-chunk sequences,
the agenda undated-window count and due-cursor branch, the two template
depth batches, the transient `read_attachment_meta` failure, and the two
caches' stored keys and values. Four `beforeEach` catch-alls became narrow
per-file installers that default only the commands the module under test
can fire; anything else fails by name. `export-graph`'s `read_attachment`
bytes live in a fallback, the sanctioned place for a command with no
binding. No assertion weakened; 313 tests keep what they asserted.

## Falsification

The builder's: a `list_trash` page without `total_count` fails `typecheck`
with TS2741 on `PageResponse<BlockRow>`; a `{ id, content }` heading fails
with TS2322 naming the four missing `PageHeading` columns; a broken
depth-batch handler fails the recursive template copy test. Mine,
independently, on a copy: dropping `total_count` from a `query_by_property`
handler return in `agenda-filters.test.ts` fails `typecheck` with TS2322
against `TypedInvokeHandler<"query_by_property">`. All restored and
`cmp`-verified, typecheck back to exit 0.

## Verified

- vitest on the eight files plus the ratchet: 9 files, 313 passed; by the
  builder and again by me. Per-file counts unchanged.
- `npm run typecheck` exit 0, twice; oxlint and oxfmt clean on the files.
- Not run locally: the full suites (CI carries them; the laptop is in use).
