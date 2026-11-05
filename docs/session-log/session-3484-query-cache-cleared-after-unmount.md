# Session 3484 — query cache cleared after unmount

Set out to fix #6352: `QueryResult.test.tsx` "error region with Retry button has no a11y violations" failed once on CI, unable to find the Retry button.

The issue guessed a 1 s `findByRole` default racing the rejected IPC. That premise was false: `src/test-setup.ts` raises `asyncUtilTimeout` to 8 s, and the DOM in the CI log showed "1 result" and a "Recovered" row, which is the previous test's ("Retry button re-invokes the query on click") data under the same query key. The error region never rendered because `useQueryExecution` surfaces a backend error only when no page is cached.

Cause: the shared `afterEach` cleared the module-level TanStack client before RTL `cleanup()` (vitest runs `afterEach` hooks in `'stack'` order, so the later-registered clear ran first). `cleanup()` unmounts the tree, which flushes any committed-but-pending passive effects; TanStack's `useBaseQuery` effect calls `observer.setOptions`, which rebuilds the query `clear()` had just removed and refetches it on the old test's mock. Instrumenting the hooks showed 18 of the file's 85 tests leaving a cached query behind; with the clear moved after `cleanup()` in the same hook, 0. Whether a given test leaks depends on a late update landing outside `act` just before the test ends, which is the load sensitivity.

Shipped: the clear moved into the `cleanup()` hook, after it, and `src/__tests__/query-cache-teardown.test.tsx`, which ends a test with an update committed outside `act` and asserts in `afterAll` that the cache is empty. It is red 5/5 against the old hook order and green 5/5 with the fix. Ran: the new test both ways, `QueryResult.test.tsx` under CPU stress with `--sequence.shuffle`, the full vitest suite (green), `npm run typecheck`, oxlint and oxfmt.

A shuffled run under load once failed `QueryResult` "renders loading state", which is a different order-dependent test; not chased here.
