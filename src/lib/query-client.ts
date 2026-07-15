/**
 * query-client — the single, module-level TanStack Query client for the
 * read-only query surface (#2596 pilot).
 *
 * ## Why a module-level singleton (not just a provider)
 *
 * Agaric is local-first: reads are sub-millisecond IPC calls, there is no
 * server to poll, and invalidation is *event-driven* off the materializer's
 * `block:properties-changed` dispatcher rather than time-based staleness. A
 * single client shared process-wide matches the module-level `Map` caches it
 * replaces (`property-keys-cache` / `property-values-cache`), and lets the two
 * worlds that consume those caches — React hooks AND plain-TS callers
 * (`searchPropertyKeys` in `slash-commands.ts`) — share one cache and one
 * in-flight fetch per key.
 *
 * The migrated hooks pass this client *explicitly* as the second argument to
 * `useQuery` / `useInfiniteQuery`. That keeps them independent of a
 * `QueryClientProvider` ancestor, so the large bare-`render()` component-test
 * suite needs no provider-wrapper churn (a component that reaches
 * `useAutocompleteSources` / `useQueryExecution` resolves its client from this
 * singleton, not from React context). The provider is still mounted once at the
 * app root (`main.tsx`) — the idiomatic wiring the pilot issue calls for, and
 * the client any future context-based consumer or React Query Devtools would
 * pick up.
 *
 * ## Guardrail (load-bearing — #2596)
 *
 * READ PATH ONLY. This client caches read-only, derived/aggregate/search
 * views. It must NEVER be layered over the op_log → materializer → Loro write
 * path surfaced through the Zustand stores — that would create two competing
 * caches that can drift and duplicate the materializer's invalidation job.
 */

import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Reads are sub-ms and the source of truth invalidates via
      // `block:properties-changed` events, not the clock. Favour cache hits +
      // explicit event invalidation over time-based refetch.
      staleTime: Number.POSITIVE_INFINITY,
      // Session-lifetime cache, matching the module-level `Map`s this client
      // replaces (they never GC'd within a session).
      gcTime: Number.POSITIVE_INFINITY,
      // There is no server: nothing to refetch on focus/reconnect.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // The hand-rolled caches surfaced IPC failures immediately (error → []
      // fallback for autocomplete; error string for query execution) without
      // retrying. Keep that behaviour so failure modes stay comparable.
      retry: false,
    },
  },
})
