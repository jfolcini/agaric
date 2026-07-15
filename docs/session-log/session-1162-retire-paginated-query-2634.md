## Session 1162 — Migrate the two COMPLEX `usePaginatedQuery` consumers and RETIRE the hook (#2634 final) (2026-07-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-15 |
| **Subagents** | 2 build + 3 review |
| **Items closed** | `#2634` (staged `usePaginatedQuery` retirement complete) |
| **Items modified** | `#2634` |
| **Tests added** | 2 (UnfinishedTasks mid-drain-failure; useSearchResults cap arithmetic) |
| **Files touched** | 10 (2 deleted) |

**Summary:** Final PR of the staged `usePaginatedQuery` → TanStack migration (#2634). Migrates the two **COMPLEX** consumers — `UnfinishedTasks` (drain mode) and `useSearchResults` (`errorDetail` + `capped` + `setItems` + AbortSignal, **plus** the chosen event-driven live-refresh) — off the generic hook onto `useInfiniteQuery(options, queryClient)`, then **deletes `usePaginatedQuery.ts` + its test** now that all 8 consumers are off it. Read-path only. Two parallel builders, three independent adversarial reviewers (no self-review) — review caught one **BLOCKING** bug and one HIGH-priority coverage hole, both fixed here.

**Files touched (this session):**
- `src/components/journal/UnfinishedTasks.tsx` — `usePaginatedQuery(drain)` → `useInfiniteQuery`. Key `['unfinishedTasks', space, todayStr]`. Drain reproduced by an effect that `fetchNextPage()`s while `hasNextPage && !isFetchingNextPage && pages < MAX_UNFINISHED_PAGES` (25). **BLOCKING fix (review):** a page failing mid-drain left `loading` stuck true forever (skeleton frozen) — `retry` is off, so a failed `fetchNextPage` leaves `hasNextPage` true with no fetch in flight. Added `!isError` to both the drain-effect guard and the `loading` derivation so the panel settles and renders the pages that loaded. Deferred title resolution to `!loading` (was firing `batchResolve` once per drained page → now once per drain). `gcTime: 5min` (the key carries `todayStr`, which advances daily). Regression test added (proven to time out on the stuck skeleton without the fix).
- `src/components/SearchPanel/useSearchResults.ts` — `usePaginatedQuery` → `useInfiniteQuery`. Key `['searchBlocks', space, freeText, filterParams, caseSensitive, wholeWord, isRegex, invalidationKey]`. **Event-driven live-refresh** (the chosen search design): `useBlockPropertyEvents().invalidationKey` folded into the key so a `block:properties-changed` bump re-runs the visible search (documented tradeoff: a bump restarts at page 1, so deep "Load more" depth collapses — `keepPreviousData` masks it; the in-place `invalidateQueries` alternative costs N search scans/bump). `gcTime: 5min` bounds the per-bump churn. AbortSignal forwarded; `errorDetail`/`error`/cancellation reproduce `deriveErrorState`; `capped`/`hasMore`/`loadMore` gated on `results.length < 5000`; `setItems([])` kept as a `setQueryData` clear + `results` derives `[]` when disabled. `searchLoading = tagResolutionPending || isFetching` (keeps the busy signal continuous across the #717 tag-resolution→search handoff, avoiding a transient "No results" flash).
- **Deleted:** `src/hooks/usePaginatedQuery.ts`, `src/hooks/__tests__/usePaginatedQuery.test.ts` — no importers remain.
- `src/components/SearchPanel/__tests__/useSearchResults.capped.test.ts` (**new**) — drives the REAL cap arithmetic to the 5000 boundary (capped latch, `hasMore` kill, `loadMore` gate). Closes the coverage hole the retired hook's test left (its arithmetic covered the OLD implementation). Proven to fail without the cap logic.
- `SearchPanel.capped.test.tsx` — mock re-targeted from `usePaginatedQuery` to `useSearchResults` (the hook the panel now consumes). `SearchPanel.test.tsx` / `SearchPanel.handoff.test.tsx` — `queryClient.clear()` in `beforeEach` (singleton isolation). `UnfinishedTasks.test.tsx` — +1 regression test.
- `docs/architecture/search.md`, `docs/architecture/pages-view.md` — repointed off the deleted hook (search pipeline now `useInfiniteQuery` + event-driven refresh; pages-view data-flow box now `useInfiniteQuery` via `usePageBrowserData`).

**Consumer-complexity matrix (#2634) — COMPLETE:**
- SIMPLE (PR1): `HistoryPanel`, `DonePanel`. MEDIUM (PR2): `usePageBrowserData`, `TrashView`, `TagFilterPanel`, `HistoryView`. COMPLEX (this PR): `UnfinishedTasks`, `useSearchResults`. Hook retired.

**Verification:**
- 2 builders + 3 independent adversarial reviewers. UnfinishedTasks review: BLOCKING stuck-skeleton (fixed), per-page `batchResolve` + day-keyed `gcTime` (fixed). Search review: cap-arithmetic coverage hole (fixed via new test), inaccurate cap comment (corrected), pagination-reset-on-invalidation (documented tradeoff), handoff-test isolation (fixed); AbortSignal / error / setItems / regex-error discrimination verified clean.
- `npx tsc -b --noEmit` 0 errors; `oxfmt --check` + `oxlint` clean; both doc-citation guards (`check-doc-code-paths`, `check-architecture-citations`) green after the deletion.
- `npx vitest run` (full suite) — all passing.

**Commit plan:** single commit; pushed; PR against main — `Closes #2634` (final consumer wave + hook deletion).
