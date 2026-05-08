/**
 * usePropertyKeysCache — React adapter over the module-level cache in
 * `src/lib/property-keys-cache.ts` (PEND-35 Tier 2.5).
 *
 * Three components consume the property-key list to populate filter
 * pickers (`PropertyValuePicker`, `BacklinkFilterBuilder` inside
 * `LinkedReferences` / `UnlinkedReferences`). Before MAINT-189 each
 * component fired its own `useEffect([])` IPC on mount, so a view
 * with a backlink panel + several filter rows hit the IPC N times
 * for identical data. The cache collapses every consumer of the same
 * `spaceId` to a single in-flight fetch and shares the cached result
 * across mounts.
 *
 * PEND-35 Tier 2.5 added a non-React caller (`searchPropertyKeys` in
 * `src/lib/slash-commands.ts`) that bypassed the cache because the
 * primitives lived in this hook file. The cache state and the IPC
 * helpers were moved to a plain module so both worlds share the same
 * Map / in-flight / subscriber set. This file is now a thin React
 * binding that wires those primitives into `useSyncExternalStore`,
 * and re-exports the public surface so existing callers
 * (`invalidatePropertyKeysCache`, `_resetPropertyKeysCacheForTest`)
 * keep importing from `../hooks/usePropertyKeysCache`.
 *
 * The cache is keyed on `spaceId` even though the underlying IPC is
 * not yet space-scoped, so future per-space migration is a one-line
 * backend change that doesn't need to ripple through the consumers.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  ensurePropertyKeysInvalidationListener,
  fetchPropertyKeysOnce,
  getCachedPropertyKeys,
  PROPERTY_KEYS_GLOBAL_KEY,
  subscribeToPropertyKeysCache,
} from '../lib/property-keys-cache'

// Re-exports keep the historical import path working for tests and
// any caller that already imports `invalidatePropertyKeysCache` /
// `_resetPropertyKeysCacheForTest` from this file.
export {
  _resetPropertyKeysCacheForTest,
  invalidatePropertyKeysCache,
} from '../lib/property-keys-cache'

/**
 * Returns the cached list of property keys for the given space,
 * starting an IPC fetch on first use per `spaceId`. Subsequent mounts
 * with the same `spaceId` reuse the cached array; different
 * `spaceId`s fetch independently. Returns the stable empty array
 * before the first fetch resolves.
 */
export function usePropertyKeysCache(spaceId: string | null): string[] {
  const spaceKey = spaceId ?? PROPERTY_KEYS_GLOBAL_KEY

  useEffect(() => {
    ensurePropertyKeysInvalidationListener()
    void fetchPropertyKeysOnce(spaceKey)
  }, [spaceKey])

  const getSnapshot = useCallback(() => getCachedPropertyKeys(spaceKey), [spaceKey])

  return useSyncExternalStore(subscribeToPropertyKeysCache, getSnapshot)
}
