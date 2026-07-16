## Session 1163 — Address non-blocking TanStack parity nits (#2639) (2026-07-16)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-16 |
| **Subagents** | 1 review |
| **Items closed** | — (partial #2639; #2 + #3b deferred) |
| **Items modified** | `#2639` |
| **Tests added** | 2 (refetch-on-revisit: TrashView + HistoryView) |
| **Files touched** | 7 |

**Summary:** Cleans up the non-blocking parity divergences that adversarial review flagged during the #2634 `usePaginatedQuery` → TanStack migration (tracked in #2639). All stem from the pilot's `staleTime: Infinity` (cache-hit) model replacing the old hook's refetch-on-every-deps-change. Read-path only; no new IPC/schema.

**Files touched (this session):**
- `src/components/TrashView.tsx`, `src/components/history/HistoryView.tsx` — **`staleTime: 0`** (#2639 item 1). Space / op-type-filter switches are in-place (no route remount), so `refetchOnMount:'always'` alone didn't re-hit the backend on an A→B→A return — TanStack served the cached, possibly-stale list. `staleTime: 0` marks each key immediately stale, so re-observing a cached basis triggers a background refetch (window/reconnect refetch stay off, so no time-based churn). Reviewer confirmed no optimistic-write race: `setQueryData` on the same key doesn't re-observe, nothing invalidates `['trash', …]`, and restore/purge are awaited before the optimistic removal so even a background refetch hits a backend that already excludes the row.
- `src/components/TrashView.tsx`, `src/components/history/HistoryView.tsx`, `src/components/history/HistoryPanel.tsx`, `src/components/filters/TagFilterPanel.tsx`, `src/hooks/usePageBrowserData.ts` — **`&& !isFetching`** added to the error-toast effect in all 5 consumers (#2639 item 3a). The first-render `errorUpdatedAt` ref alone didn't guard a cached error whose failing key is selected *after* mount (baseline captured while disabled → 0); `refetchOnMount:'always'` puts the query straight into `isFetching` while it re-validates, so a stale cached failure can't toast before the fresh fetch settles. A genuinely settled error (isError + !isFetching + advanced errorUpdatedAt) still toasts — the error state and `fetchStatus:'idle'` commit atomically.
- `src/components/filters/TagFilterPanel.tsx` — **`hasMore = hasQuery && hasNextPage && !isPlaceholderData`** (#2639 item 3c). `isPlaceholderData` is true only for a `keepPreviousData` key-change placeholder (never during a same-key `fetchNextPage`), so the stray disabled "Load more" that flashed during an AND/OR mode switch is suppressed while the button stays live during a genuine load-more.
- `src/components/history/HistoryView.tsx` — **`errorCategory` derived from the query error** instead of component `useState` set inside the queryFn (#2639 item 4). On remount the cached error survives, so deriving `isError && queryError != null ? categorizeHistoryError(queryError) : null` keeps the banner's network/server/unknown detail line correct immediately, instead of flashing the `unknown` fallback until `refetchOnMount` re-ran. Removed the two `setErrorCategory` side-effects; `useState` still used for other state.
- `src/components/__tests__/TrashView.test.tsx`, `src/components/history/__tests__/HistoryView.test.tsx` — one refetch-on-revisit regression test each (A→B→A / filter-switch), both proven to fail without `staleTime: 0`.

**Deferred (documented on the PR; #2639 kept open):**
- Item 2 (`reload()`→`refetch()` refetches all loaded pages instead of collapsing to page 1) — the faithful fix (`resetQueries`) trades current behaviour for a skeleton flash; wants its own decision, and the dup/skip-row risk is narrow.
- Item 3b (`keepPreviousData` shows the prior tag's rows dimmed after a clear→re-enable) — can't be fixed without losing the desired stale-while-revalidate; purely cosmetic.

**Verification:**
- 1 adversarial reviewer — verdict "essentially CLEAN, no blocking/correctness regressions"; confirmed the staleTime/optimistic-write non-race, the `!isFetching` gate's safety+necessity, the errorCategory derivation faithfulness, and that both new tests are non-flaky and fail without their fix. Its two "under-tested" nits (HistoryView staleTime lock; TagFilterPanel placeholder-hasMore lock) — HistoryView test added this session; the TagFilterPanel placeholder case is left to the verified-correct logic (a mid-switch placeholder with `has_more:true` is fiddly to stage and purely cosmetic).
- `npx tsc -b --noEmit` 0 errors; `oxfmt --check` + `oxlint` clean.
- `npx vitest run` (full suite) — 662 files, all passing.

**Commit plan:** single commit; pushed; PR against main (references #2639, does NOT close it — items 2 + 3b remain).
