## Session 1158 — Extend TanStack Query to Advanced Query (#2597 surface 3) (2026-07-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-15 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | — (partial #2597 — third per-surface PR) |
| **Items modified** | `#2597` |
| **Tests added** | — (existing suites preserved) |
| **Files touched** | 2 |

**Summary:** Third extension of the #2596 TanStack Query pilot (#2597). Migrated `useAdvancedQuery`'s hand-rolled `fetchResults` cursor state machine (10 `useState` + a `useRef` `reqIdRef` race-guard) to `useInfiniteQuery`, preserving the public return interface exactly so the sole consumer (`AdvancedQueryView`) is untouched. Read-only surface (`runAdvancedQuery` + `batchResolve`); the `advancedQueryStore` is builder/filter *config* only and is not touched.

**Files touched (this session):**
- `src/hooks/useAdvancedQuery.ts` (380 → 416) — `useInfiniteQuery(options, queryClient)`. Query key `['advancedQuery', spaceId, filtersKey, filterExprKey, trimmedFulltext, sortKey, groupByKey, aggregatesKey]` (the old callback's dep identity). Reused `buildQueryArgs` verbatim so the empty-input minimal-wire-shape + stale-Relevance-drop are byte-identical. Flat vs grouped both derived from `data.pages` (flatten rows / concatenate groups in page order, **no** merge-by-key — matching the old verbatim append); first-page-only aggregates + `totalCount` from `data.pages[0]`; page-title resolution folded into the queryFn per page (members + Tag/Page group-key ids, #1447), merged later-pages-last; `logger.warn` in the queryFn catch. Deleted the `reqIdRef` guard + the whole manual state machine.
- `src/hooks/__tests__/useAdvancedQuery.test.ts` + the four `src/components/AdvancedQuery/**` component suites — assertions unchanged; only `queryClient.clear()` added to each `beforeEach` for singleton isolation.

**Three deliberate caching deviations (parity-driven — both builder and reviewer confirmed correct AND necessary):**
1. **`placeholderData: keepPreviousData`** + `loading = isFetching && !isFetchingNextPage` — the old hook kept prior results/groups/aggregates/totalCount mounted (dimmed, `aria-busy`) during an input-change refetch (`setResults`/etc. only overwrote on success). `keepPreviousData` retains the whole prior `InfiniteData`; plain `isLoading` (false under placeholder) or plain `isFetching` (true during load-more) would both be wrong, so the `&& !isFetchingNextPage` guard is load-bearing.
2. **`staleTime: 0`** overriding the singleton's `Infinity` — the old effect re-ran on **every** input change including *returning to a previously-run filter*; under `staleTime: Infinity` a return-to-prior-key serves the stale page without re-invoking the engine, failing the "remove leaf → back to empty conjunction" test. The reviewer proved necessity by flipping it back to `Infinity` and watching the test fail; confirmed no double-fetch on mount and no refetch storm.
3. **Error-suppression via `isFetchNextPageError`** (not `useQueryExecution`'s `pages.length === 0`) — old code suppressed only load-more errors. With `keepPreviousData`, a page-1 refetch error leaves `data.pages` non-empty, so the pages-length heuristic would wrongly suppress it; keying off `isFetchNextPageError` correctly surfaces initial/page-1 errors and suppresses only load-more.

**Verification:**
- 1 builder + 1 adversarial reviewer (SHIP, no defects). The review wrote its own scratch tests (A→B→A key return, single-mount no-double-fetch, page-1-vs-load-more error) and flipped `staleTime` to prove each deviation was necessary, not incidental.
- `npx tsc -b --noEmit` — 0 errors; `oxlint` clean.
- `npx vitest run` (full suite) — 662 files, 15062 tests, all passed.

**Process notes:** unlike surfaces 1–2 (which kept the singleton's `staleTime: Infinity`), Advanced Query's old "re-run on every input change" semantics required per-hook `staleTime: 0` + `keepPreviousData`. This is the first surface where the read genuinely wanted time-fresh-on-return rather than event-invalidated caching — a useful data point for the #2597 write-up: not every read-path surface has the same caching profile.

**Commit plan:** single commit; pushed; PR against main (partial #2597 — not `Closes`).
