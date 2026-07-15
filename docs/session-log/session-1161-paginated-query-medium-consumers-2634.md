## Session 1161 — Migrate 4 MEDIUM `usePaginatedQuery` consumers to `useInfiniteQuery` (#2634 PR2) (2026-07-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-15 |
| **Subagents** | 4 build + 4 review |
| **Items closed** | — (second of several per-consumer PRs for #2634) |
| **Items modified** | `#2634`; opened follow-up `#2639` |
| **Tests added** | 1 (count-chip regression) |
| **Files touched** | 5 |

**Summary:** Second PR of the staged `usePaginatedQuery` → TanStack migration (#2634). Migrates the four **MEDIUM** consumers (those whose old `setItems` optimistic writes become `queryClient.setQueryData`) off the retired generic hook onto `useInfiniteQuery(options, queryClient)` directly: `usePageBrowserData`, `TrashView`, `TagFilterPanel`, `HistoryView`. Read-path only; behaviour parity. Four parallel builders, then four independent adversarial reviewers (no self-review) — the review round caught one **BLOCKING** regression and one **unbounded-cache** leak, both fixed here; the remaining confirmed findings are accepted design tradeoffs (matching the merged `HistoryPanel`/`DonePanel`) and are tracked in **#2639**.

**Files touched (this session):**
- `src/hooks/usePageBrowserData.ts` — `usePaginatedQuery` → `useInfiniteQuery`. Query key `['pageBrowserData', currentSpaceId, sortOption, wireFilters]` (raw `sortOption`, matching the old `useCallback` closure — `created`/`recent`/`alphabetical`/`default` all map to wire `default`, so switching among them re-keys and refetches redundantly, exactly as before). **`staleTime: 0`** so returning to an already-cached filter basis (remove a chip → back to `filters: []`) re-issues the IPC (compound-filter parity — the old hook re-ran on every deps change). **`placeholderData: keepPreviousData`**. Custom `setPages` reshapes `InfiniteData` (pure-removal branch preserves per-page structure; growth/replace collapses to a single page carrying the last page's pagination). **BLOCKING fix (review):** `displayTotalCount` — the count chip vanished on every sort change because `totalCount` is now *derived* from `data` and `keepPreviousData` keeps `data` defined, so a same-total basis change (sort never changes the count) never transitioned `totalCount`, and the adopt effect (keyed `[totalCount]`) never re-fired after the reset effect blanked it. Fixed by keying the adopt effect on the fetch **settle** transition (`[isFetching, totalCount]`, gated on `!isFetching`), reproducing the old `undefined→N` write on every deps change. Regression test added and proven to fail without the fix.
- `src/components/TrashView.tsx` — `useInfiniteQuery`, key `['trash', currentSpaceId]`, `keepPreviousData`. `setBlocks` → per-page `setQueryData` filter (equivalent to the old flat filter for the two removal call sites). `reload = refetch`.
- `src/components/filters/TagFilterPanel.tsx` — `useInfiniteQuery`, key `['tagFilterBlocks', currentSpaceId, tagExpr, flatParams]`. Reproduces the old `!hasQuery → setItems([])` clear by deriving `results = hasQuery ? … : []` and `hasMore = hasQuery && hasNextPage`. **Unbounded-cache fix (review):** the key churns on *every filter edit* (tag add/remove, and/or/not toggle, prefix pill, composer edit), so `gcTime: Infinity` would retain every superseded page set for the whole session; bounded with **`gcTime: 5*60*1000`** (the `DonePanel` rationale) and the incorrect "stable across property changes" comment rewritten.
- `src/components/history/HistoryView.tsx` — `useInfiniteQuery`, key `['pageHistory', opTypeFilter, effectiveSpaceId ?? null]`, `keepPreviousData`. `setItems([]); reload()` (in `reloadAfterMutation`) → **`queryClient.resetQueries({ queryKey })`** (clears to skeleton + refetches page 1 only; `refetch()` would have kept stale via `keepPreviousData` and re-requested all pages — the reviewer confirmed reset is correct). `error` derived as a string (banner renders it; parity — old `error` was also the `onError` string).
- `src/hooks/__tests__/usePageBrowserData.test.ts` — +1 regression test locking the count-chip-on-unchanged-total case.

**Consumer-complexity matrix status (#2634):**
- **SIMPLE** (PR1, merged): `HistoryPanel`, `DonePanel`.
- **MEDIUM** (this PR): `usePageBrowserData`, `TrashView`, `TagFilterPanel`, `HistoryView`.
- **COMPLEX** (next): `useSearchResults` (`errorDetail` + `capped` + `setItems`, plus the chosen event-driven search live-refresh), `UnfinishedTasks` (`drain`). Then delete `usePaginatedQuery.ts`.

**Verification:**
- 4 builders + 4 independent adversarial reviewers. Reviewers confirmed the hard parts sound (`setPages`/`setBlocks` per-page reshaping ≡ old flat filter; `resetQueries` vs `refetch` choice; `keepPreviousData` stale-while-revalidate; `hashKey` ≡ old `JSON.stringify`; no-signal parity; onError mount-ref guard). Findings actioned: BLOCKING count-chip fixed; TagFilterPanel unbounded `gcTime` fixed. Deferred (non-blocking, match merged siblings): no-refetch-on-revisit (TrashView/HistoryView), `reload` refetches-all-pages, TagFilterPanel remount re-toast / placeholder-flash / load-more-during-switch, HistoryView remount error-category flash → all tracked in **#2639**.
- `npx tsc -b --noEmit` — 0 errors; `oxfmt --check` + `oxlint` clean (builders had run oxlint but not oxfmt; 3 files reformatted).
- `npx vitest run` (full suite) — all passing.

**Commit plan:** single commit; pushed; draft PR against main (partial #2634 — not `Closes`; COMPLEX consumers follow).
