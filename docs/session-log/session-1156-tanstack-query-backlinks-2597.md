## Session 1156 — Extend TanStack Query to backlinks grouped reads (#2597 surface 1) (2026-07-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-15 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | — (partial #2597 — first of several per-surface PRs) |
| **Items modified** | `#2597` |
| **Tests added** | +1 hook suite (`useBacklinkGroups`) |
| **Files touched** | 4 |

**Summary:** First extension of the merged #2596 TanStack Query pilot to the remaining read-only surface (#2597). Migrated `LinkedReferences`'s hand-rolled grouped/paginated backlink fetch (`fetchGroups` cursor state machine) to a new `useInfiniteQuery`-backed `useBacklinkGroups` hook, preserving behaviour exactly. Read-path only — the op_log/materializer/Zustand write path is untouched. Scoped to LinkedReferences per the issue's one-surface-per-PR rule; `UnlinkedReferences` and the `useBacklinkResolution` title cache remain follow-up PRs.

**Files touched (this session):**
- `src/hooks/useBacklinkGroups.ts` (NEW, 155) — `useInfiniteQuery(options, queryClient)` over `listBacklinksGrouped`. Query key `['backlinkGroups', spaceId, pageId, invalidationKey, filters, sort, sourcePageIncluded, sourcePageExcluded]`; `getNextPageParam` off `has_more`/`next_cursor`; `refetchOnMount: 'always'`. Derives group-merge-by-`page_id` (fresh objects, first-appearance order — #1529), first-page-only `totalCount` (#2201 1b), `loading`/`hasMore`/`isFetchingMore`/`loadMore`/`isError`. `logger.error` in the queryFn catch-then-rethrow (observability parity).
- `src/components/backlinks/LinkedReferences.tsx` (446 → 413, −33) — consumes the hook; removed 5 `useState`s + the ~100-line `fetchGroups` + the load/refetch effects. Kept all other state/UI. Parity effects: error toast on `isError` (deduped `{ id }`), expand-state seeding via a `seededIdentityRef` keyed on the full query identity (fresh first page → `≤5 || i<3` rule; load-more defaults new `page_id`s to expanded without clobbering user toggles), and `clearCache()` keyed on that same `queryIdentity` so a property-change (`invalidationKey`) re-resolves `[[ULID]]`/`#[ULID]` titles rather than leaving a renamed target stale for the 5-min resolution TTL.
- `src/hooks/__tests__/useBacklinkGroups.test.ts` (NEW) — happy path, load-more merge (+ no-mutation + first-page `totalCount` invariance), error path, `invalidationKey`→refetch (asserts a real second IPC).
- `src/components/backlinks/__tests__/LinkedReferences.test.tsx` — assertions unchanged; only `queryClient.clear()` added to `beforeEach` (isolate the `gcTime:Infinity` singleton) and one `getByTestId`→`findByTestId` await for the `useInfiniteQuery` load window.

**Verification:**
- 1 builder + 1 adversarial reviewer (SHIP, no defects). Reviewer independently re-derived the four expand-seeding scenarios (fresh/append/user-collapse-preserved/identity-change) and wrote a throwaway test confirming a rejected `fetchNextPage` (`retry:false`) keeps `data.pages[0]` so existing groups survive a load-more failure while `isError` fires the toast.
- Reviewer flagged a `clearCache`-scope divergence (old cleared on every fetch identity incl. `invalidationKey`; builder had keyed it to `[pageId, spaceId]` only) — fixed by re-keying to `queryIdentity`, restoring exact title-staleness parity.
- `npx tsc -b --noEmit` — 0 errors; `oxfmt` + `oxlint` clean on changed files.
- `npx vitest run` (full suite) — 661 files, 15058 tests, all passed.

**Process notes:** built on the pilot's explicit-client pattern (singleton `queryClient` passed as `useInfiniteQuery`'s 2nd arg) so no provider-wrapper churn in the bare-`render()` backlink component tests. `invalidationKey` folded into the query key replaces the old dep-array refetch trick for F-39.

**Commit plan:** single commit; pushed; PR against main (partial #2597 — not `Closes`).
