## Session 1160 — Migrate first `usePaginatedQuery` consumers to `useInfiniteQuery` (#2634 PR1) (2026-07-15)

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
- `src/components/history/HistoryPanel.tsx` — `usePaginatedQuery` → `useInfiniteQuery(options, queryClient)`. Query key `['blockHistory', blockId, opTypeFilter]`; `loading = isFetching` (true on initial AND load-more, matching the old single `loading`); `refetchOnMount: 'always'`; **`placeholderData: keepPreviousData`** so an `opTypeFilter` change keeps the prior entries visible instead of blanking to a skeleton (stale-while-revalidate parity — `usePaginatedQuery` never cleared items on a deps change); `getBlockHistory` takes no signal so none is forwarded (as before). `onError` toast via an effect keyed on `[isError, errorUpdatedAt, t]` — `errorUpdatedAt` advances on every failed load so consecutive same-key load-more failures each re-toast (a plain `isError` dep would toast once); a `lastToastedErrorAtRef` captures the first-render value so a cached error on remount (gcTime Infinity) is not re-toasted before `refetchOnMount` resolves. No monotonic key → inherits `gcTime: Infinity`.
- `src/components/agenda/DonePanel.tsx` — same pattern + **`placeholderData: keepPreviousData`** (load-bearing here: its key carries the monotonic `invalidationKey`, so without it every debounced `block:properties-changed` would flash the completed list to a skeleton and lose scroll/focus). Query key `['donePanelCompleted', spaceId, date, excludePageId ?? null, invalidationKey]`; `gcTime: 5*60*1000` bounds per-bump inactive entries (the #2628 lesson). `error = isError ? queryError : null`; the render gates the error panel on `error && blocks.length===0`, so a failed `fetchNextPage`/refetch (which DOES flip `isError` in v5, even with data) keeps items visible; `reload`/`retryLoad` → `refetch`.
- `HistoryPanel.test.tsx` (+2 siblings) and `DonePanel.test.tsx` — assertions unchanged; only `queryClient.clear()` added to each `beforeEach` (singleton isolation).

**Consumer-complexity matrix (posted to #2634, 8 real consumers):**
- **SIMPLE** (migrated here): `HistoryPanel`, `DonePanel`.
- **MEDIUM** (`setItems` optimistic → `queryClient.setQueryData`): `usePageBrowserData`, `TrashView`, `TagFilterPanel`, `HistoryView`.
- **COMPLEX** (last): `useSearchResults` (`errorDetail` + `capped` + `setItems`), `UnfinishedTasks` (`drain`).

**Verification:**
- 1 builder + 2 adversarial review rounds. Round 1 confirmed `loading = isFetching`, the queryKey stale-guard, the `gcTime` split, and matrix accuracy, and flagged the consecutive-load-more-failure toast (fixed via `errorUpdatedAt`). Round 2 (a PR review on #2638) caught a **blocking stale-while-revalidate regression** — the retired `usePaginatedQuery` never cleared items on a deps change, so with inputs in the key the lists would flash to a skeleton (DonePanel on *every* task edit via `invalidationKey`); fixed with `placeholderData: keepPreviousData` on both (the sibling `useAdvancedQuery` pattern). Round 2 also caught the stale-error-toast-on-remount (fixed via the mount-captured `errorUpdatedAt` ref) and an inaccurate DonePanel comment (corrected).
- `npx tsc -b --noEmit` — 0 errors; `oxfmt` + `oxlint` clean.
- `npx vitest run` (full suite) — 662 files, 15062 tests, all passed.

**Commit plan:** single commit; pushed; PR against main (partial #2634 — not `Closes`; the MEDIUM/COMPLEX consumers follow as their own PRs).
