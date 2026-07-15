## Session 1159 — Migrate first `usePaginatedQuery` consumers to `useInfiniteQuery` (#2634 PR1) (2026-07-15)

> NOTE: if this file collides with another `session-1159-*` on `main` at merge time (a sibling PR landed first), renumber it to the next free number before merging.

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-15 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | — (first of several per-consumer PRs for #2634) |
| **Items modified** | `#2634` |
| **Tests added** | — (existing suites preserved) |
| **Files touched** | 6 |

**Summary:** First PR of the staged `usePaginatedQuery` → TanStack migration (#2634). The generic cursor-pagination hook can't be swapped as an API-compatible drop-in (its "refetch on `queryFn` *reference* change" model has no serializable `queryKey`), so it's retired **per-consumer**. This PR migrates the two simplest consumers — `HistoryPanel` and `DonePanel` — to `useInfiniteQuery` directly, and posts a consumer-complexity matrix (on #2634) to plan the rest. Read-only; behaviour parity.

**Files touched (this session):**
- `src/components/history/HistoryPanel.tsx` — `usePaginatedQuery` → `useInfiniteQuery(options, queryClient)`. Query key `['blockHistory', blockId, opTypeFilter]`; `loading = isFetching` (true on initial AND load-more, matching the old single `loading`); `refetchOnMount: 'always'`; `getBlockHistory` takes no signal so none is forwarded (as before). `onError` toast reproduced via an effect keyed on `[isError, errorUpdatedAt, t]` — `errorUpdatedAt` advances on every failed load so consecutive same-key load-more failures each re-toast (a plain `isError` dep would latch and toast only once). No monotonic key → inherits the client's `gcTime: Infinity` (bounded distinct values, no leak).
- `src/components/agenda/DonePanel.tsx` — same pattern. Query key `['donePanelCompleted', spaceId, date, excludePageId ?? null, invalidationKey]`; because it carries a monotonic `invalidationKey`, it sets `gcTime: 5*60*1000` (bounding per-bump inactive entries under the client's Infinity default — the #2628 lesson). `error = isError ? queryError : null`; a failed `fetchNextPage` keeps `data`, so the `error && blocks.length===0` render guard stays false and items remain visible (load-more resilience); `reload`/`retryLoad` → `refetch`.
- `HistoryPanel.test.tsx` (+2 siblings) and `DonePanel.test.tsx` — assertions unchanged; only `queryClient.clear()` added to each `beforeEach` (singleton isolation).

**Consumer-complexity matrix (posted to #2634, 8 real consumers):**
- **SIMPLE** (migrated here): `HistoryPanel`, `DonePanel`.
- **MEDIUM** (`setItems` optimistic → `queryClient.setQueryData`): `usePageBrowserData`, `TrashView`, `TagFilterPanel`, `HistoryView`.
- **COMPLEX** (last): `useSearchResults` (`errorDetail` + `capped` + `setItems`), `UnfinishedTasks` (`drain`).

**Verification:**
- 1 builder + 1 adversarial reviewer (SHIP). The review confirmed `loading = isFetching` (not `isLoading`), stale-guard via queryKey (both dedicated stale tests pass for the right reason), the `gcTime` split (DonePanel needs it, HistoryPanel correctly doesn't), AbortSignal N/A, and matrix accuracy (neither migrated consumer used `setItems`/`capped`/`errorDetail`/`drain`). It flagged one low-severity gap — consecutive same-key load-more failures toasting once — which was fixed here via the `errorUpdatedAt` dep.
- `npx tsc -b --noEmit` — 0 errors; `oxfmt` + `oxlint` clean.
- `npx vitest run` (full suite) — 662 files, 15062 tests, all passed.

**Commit plan:** single commit; pushed; PR against main (partial #2634 — not `Closes`; the MEDIUM/COMPLEX consumers follow as their own PRs).
