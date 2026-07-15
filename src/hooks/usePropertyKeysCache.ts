/**
 * usePropertyKeysCache — React adapter over the TanStack Query-backed cache
 * in `src/lib/property-keys-cache.ts`.
 *
 * Three components consume the property-key list to populate filter
 * pickers (`PropertyValuePicker`, `BacklinkFilterBuilder` inside
 * `LinkedReferences` / `UnlinkedReferences`). Each used to fire its own
 * `useEffect([])` IPC on mount; the shared query collapses every consumer of
 * the same `spaceId` to a single in-flight fetch and shares the cached result
 * across mounts.
 *
 * #2596 (pilot): the hook is now a thin `useQuery` binding. It passes the
 * module-level `queryClient` singleton *explicitly* as the second argument so
 * it needs no `QueryClientProvider` ancestor, and re-exports the public
 * surface (`invalidatePropertyKeysCache`, `_resetPropertyKeysCacheForTest`)
 * so existing callers keep importing from `../hooks/usePropertyKeysCache`.
 *
 * The cache is keyed on `spaceId` even though the underlying IPC is not yet
 * space-scoped, so a future per-space migration is a one-line backend change.
 */

import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

import { queryClient } from '@/lib/query-client'

import {
  ensurePropertyKeysInvalidationListener,
  propertyKeysQueryFn,
  propertyKeysQueryKey,
  PROPERTY_KEYS_GLOBAL_KEY,
} from '../lib/property-keys-cache'

// Re-exports keep the historical import path working for tests and
// any caller that already imports `invalidatePropertyKeysCache` /
// `_resetPropertyKeysCacheForTest` from this file.
export {
  _resetPropertyKeysCacheForTest,
  invalidatePropertyKeysCache,
} from '../lib/property-keys-cache'

/** Stable empty-array reference returned before the first fetch resolves, so
 *  consumers relying on referential stability across renders don't thrash. */
const EMPTY: string[] = []

/**
 * Returns the cached list of property keys for the given space,
 * starting an IPC fetch on first use per `spaceId`. Subsequent mounts
 * with the same `spaceId` reuse the cached array; different
 * `spaceId`s fetch independently. Returns the stable empty array
 * before the first fetch resolves.
 */
export function usePropertyKeysCache(spaceId: string | null): string[] {
  const spaceKey = spaceId ?? PROPERTY_KEYS_GLOBAL_KEY

  // Wire up the event → invalidate listener. Idempotent and process-lifetime.
  useEffect(() => {
    ensurePropertyKeysInvalidationListener()
  }, [])

  const { data } = useQuery(
    {
      queryKey: propertyKeysQueryKey(spaceKey),
      queryFn: propertyKeysQueryFn,
      staleTime: Number.POSITIVE_INFINITY,
    },
    queryClient,
  )

  return data ?? EMPTY
}
