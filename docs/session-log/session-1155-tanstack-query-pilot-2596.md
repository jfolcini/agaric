## Session 1155 — TanStack Query pilot on the read-only query surface (#2596) (2026-07-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-15 |
| **Subagents** | 2 build + 2 review |
| **Items closed** | `#2596` |
| **Items modified** | `#2597` (comment only — stays gated) |
| **Tests added** | +0 net new files (2 cache-test suites rewritten in place; behaviour parity preserved) |
| **Files touched** | 14 |

**Summary:** Piloted TanStack Query v5 on Agaric's read-only query surface (#2596). Added `@tanstack/react-query` + a single module-level `QueryClient` at the app root, then migrated the two proof points — the `propKeys`/`propValues` autocomplete caches (replacing the hand-rolled `create-property-change-cache` factory) and `useQueryExecution` (replacing its `useRef` race-guard with `useInfiniteQuery`) — with identical behaviour and green tests. The hand-rolled cache + race-guard machinery for those two paths is deleted; the pilot's before/after measurement (below) supports extending, so #2597 is left open for that decision.

**Files touched (this session):**
- `package.json` / `package-lock.json` — add `@tanstack/react-query@^5.101.2` (+`@tanstack/query-core`); installed with `--force` to bypass the pre-existing `peerOptional` TS7-vs-i18next conflict (zero-runtime-impact, lockfile diff is exactly +2 packages).
- `src/lib/query-client.ts` (NEW, ~55) — module-level singleton `queryClient`; local-first defaults (`staleTime`/`gcTime` = `Infinity`, no focus/reconnect refetch, `retry: false`). Documents the read-path-only guardrail.
- `src/main.tsx` (+~10) — mount `<QueryClientProvider client={queryClient}>` at the app root.
- `src/test-setup.ts` (+~9) — global `afterEach(queryClient.clear())` so the shared singleton doesn't leak cache across tests.
- **Proof point 1 — autocomplete (net −212 LOC):**
  - `src/lib/create-property-change-cache.ts` (**−293**, deleted) — the Map/in-flight-dedup/epoch race-guard factory; now TanStack's job.
  - `src/lib/property-keys-cache.ts` (+17) — reimplemented over `queryClient` (`['propKeys', spaceKey]`); skip-when-no-new-key invalidation via `getQueriesData`.
  - `src/lib/property-values-cache.ts` (+27) — reimplemented (`['propValues', key]`); per-changed-key eviction.
  - `src/hooks/usePropertyKeysCache.ts` (+6) — `useSyncExternalStore` → `useQuery`.
  - `src/hooks/useAutocompleteSources.ts` (+31) — propKey/propValue paths → `useQuery`; tag path/static projections/generation-guard untouched.
  - `src/lib/__tests__/property-keys-cache.test.ts`, `src/lib/__tests__/property-values-cache.test.ts`, `src/hooks/__tests__/useAutocompleteSources.test.ts`, `src/hooks/__tests__/usePropertyKeysCache.test.ts` — rewritten/adjusted to pin the queryClient contract (behaviour parity).
- **Proof point 2 — paginated results (net −44 LOC):**
  - `src/hooks/useQueryExecution.ts` (+96 / −140) — `useInfiniteQuery`; deleted the `useRef` reqId guard + the `beginFetch`/`endFetch`/`applyQueryResult`/`mergePageTitles`/`handleFetchError` state machine. All exported pure helpers unchanged; test file byte-unchanged.

**Verification:**
- 2 builders + 2 adversarial reviewers (both **SHIP**, no defects). Reviewer A verified the `fetchQuery`-over-`ensureQueryData` decision against the `@tanstack/query-core` source (an invalidated query is stale under `fetchQuery` but served-stale under `ensureQueryData`; numeric `Infinity` — not `staleTime: 'static'` — preserves event invalidation). Reviewer B confirmed the stale-fetch race is satisfied by queryKey-driven latest-wins and the load-more-error asymmetry is preserved.
- `npx oxfmt --write` + `npx oxlint` on all changed files — clean.
- `npx tsc -b --noEmit` — 0 errors.
- `npx vitest run` (full suite) — 660 files, 15054 tests, all passed.

**Pilot measurement — boilerplate / bug-surface delta (the #2596 deliverable):**

*Lines of code (net, source only):* proof point 1 **−212**, proof point 2 **−44**; infra **+~74** (`query-client.ts` + provider + test reset). Net across the migrated read-path machinery: **~−180 source LOC**, dominated by deleting the 293-line hand-rolled cache factory.

*Boilerplate removed:*
- The epoch race-guard (`globalEpoch` + per-key `keyEpoch`, ~40 lines of #2025 fencing) — TanStack's in-flight/latest-wins handling replaces it.
- The in-flight `Map` dedup + subscriber `Set` + `useSyncExternalStore` snapshot/stable-empty plumbing — replaced by `useQuery`.
- The `useRef` monotonic reqId guard + manual `loading`/`error`/`cursor`/`hasMore`/`loadingMore` state machine in `useQueryExecution` — replaced by `useInfiniteQuery` derived state.

*Failure modes — before vs after:*
- **Stale write-back races** (#2025) were hand-fenced with epochs; now structurally handled by the query cache (an invalidate cancels/supersedes the in-flight fetch). One fewer hand-maintained invariant.
- **Keyed invalidation** (#2507 per-key eviction / skip-when-no-new-key) ports cleanly to `invalidateQueries` + `getQueriesData`; the new form is if anything *more* accurate (it retains known keys through an invalidate, so the skip-check never under-counts).
- **Behaviour deltas to note (not regressions):** (1) invalidation now *invalidate-and-refetches* rather than *drop-to-empty* — consumers no longer see a transient empty list before fresh data lands (a UX improvement). (2) `useQueryExecution` uses `refetchOnMount: 'always'` to reproduce the old mount-effect's fetch-on-every-mount under `staleTime: Infinity`; on remount-with-cache it shows stale-while-revalidate instead of a spinner, same IPC count.
- **New surface introduced:** one new FE dependency (maintainer-gated, sanctioned by this issue) and a shared module-level client whose cache lifecycle must be reset in tests (`test-setup.ts`). The explicit-client pattern (passing the singleton as `useQuery`'s 2nd arg) kept the large bare-`render()` component-test suite free of provider-wrapper churn.

**Recommendation:** the pilot supports **extending** (#2597) — the boilerplate/bug-surface win is real and the read-path/write-path guardrail held cleanly (nothing here touches the op_log/materializer/Zustand write path). Extend incrementally, one read-only surface per PR, keeping event-driven invalidation.

**Process notes:** the two proof points were disjoint file sets, so they ran as parallel builders in the same tree (no worktrees needed), each pipelined into its own adversarial reviewer. Infra (dependency, singleton, provider, test reset) was landed by the orchestrator up front as the shared prerequisite.

**Commit plan:** single commit; pushed; draft PR closing #2596.
