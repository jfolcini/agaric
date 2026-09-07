# Session 1587 — the child-pages tree, and why the mock hid it (#4805)

## The bug

`PagesTreeSection.fetchDescendantPages` asked `list_pages_with_metadata` for
`paginationLimit(200)`. That command's cap is `MCP_PAGE_LIMIT_CAP = 100`, so the
backend refused **every** call with `AppError::Validation` and the child-pages
tree rendered nothing — for every user, on every page, since the call site was
written.

`paginationLimit` is bounded by `PAGINATION_MAX` (200), so 200 is inside the
`SafeLimit` brand's own range. The brand guards the shape, not this command's
narrower cap, and nothing on the frontend caught it.

## Why the whole test estate was green

The mock **clamped** where the backend **rejects**:

```ts
const limit = Math.min(Number(a['limit'] ?? 50), 100)
```

So every mock-backed test asked for 200, silently got 100, and passed. That is a
direct violation of AGENTS.md invariant 10 — "Pagination `limit` is validated,
not clamped" — and the mock's own `list_blocks` helper already spells out why it
matters: *"a mock that accepted it would train callers on a contract the backend
rejects."* This is that sentence happening.

The mock now rejects, mirroring `list_pages_with_metadata_inner`.

## Two mutants, and the one that survived first

Falsified against copies, restored, `cmp`-verified.

1. **Restore the mock's clamp** → the new contract test goes red. Killed first
   time.
2. **Revert the call site to 200** → *survived*. All eight `PagesTreeSection`
   tests stayed green.

The second result is the interesting one. Those tests drive hand-written
`vi.fn()` stubs rather than the mock, so they never see any validation — and
worse, the existing wire-args assertions **pinned the buggy value**, asserting
`200` as the expected limit. The test encoded the bug it should have caught.

Fixed by asserting the cap constant instead of the literal, plus an explicit
guard that every call's limit lies in `[1, cap]`. The mutant is killed now.

## The fix surfaced a second, pre-existing violation

With the clamp gone, `pages-last-modified-op-log.test.ts` failed: its helper had
been asking for `limit: 200` too. Nothing was wrong with what that test checks —
it had simply been written against a page size the real backend refuses, because
the mock had always quietly accepted it. Corrected to 100.

That is the argument for rejecting rather than clamping, in one data point: the
leniency had already trained one unrelated test on an impossible call.

## Shape of the fix

- `LIST_PAGES_WITH_METADATA_MAX` + `listPagesWithMetadataLimit` in
  `src/lib/safe-limit.ts`, mirroring the existing `searchBlocksLimit` precedent
  for exactly this shape (brand allows 200, command caps at 100).
- `PagesTreeSection` uses the new named limit.
- The mock validates instead of clamping.
- `src/lib/tauri-mock/__tests__/pages-metadata-limit.test.ts` pins the contract
  in both directions.

## Review round: two of my own tests could not fail

The reviewer found that `pages-metadata-limit.test.ts`'s "accepts the cap" and
null-limit cases only asserted `Array.isArray(res.items)` over a two-block seed
— **both stay green with the clamp restored**. Clamping and rejecting differ
only on an OVER-cap input, so no assertion at `limit: 100` or `null` can ever
discriminate them; the `200` and `[0, -1, 101]` rejection cases carry the whole
coverage.

Deleted rather than strengthened, because there was nothing to strengthen them
into. The accept-at-cap arm is not left open: `pages-last-modified-op-log.test.ts`
dispatches this command at `limit: 100` and asserts exact row counts, so the
positive arm is genuinely pinned there, and a comment now points at it so the
pair does not read as half-covered.

Also from that round: the `MAX_DESCENDANT_PAGES` doc still promised the old
2000-descendant bound (it is 1000 now), and `listPagesWithMetadataLimit` had
exactly one caller, so it collapsed into the constant.
