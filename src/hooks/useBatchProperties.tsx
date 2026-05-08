/**
 * useBatchProperties — context-backed map of block_id → PropertyRow[].
 *
 * Fetches FULL property lists for the given block IDs in a single
 * `getBatchProperties` IPC. Mounted at the parent that knows the full
 * `blockIds` set (e.g. `AgendaResults`) so descendant components
 * (`DependencyIndicator` per row) read from the shared map instead of
 * each firing their own `getProperties` IPC on initial mount.
 *
 * Outside a provider, the hook returns `null` — components that fall
 * back to per-block fetches use `useBatchProperties()?.get(blockId)`.
 *
 * PEND-35 Tier 2.4a — collapses the per-row `getProperties` fan-out in
 * `DependencyIndicator` (which previously dedup'd only RE-RENDERS via a
 * shared cache ref, not the initial mount fan-out for N rows) into a
 * single batched query mounted at the AgendaResults level. Mirror of
 * `BatchAttachmentsProvider` (Tier 2.7).
 */

import type { ReactElement, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { logger } from '../lib/logger'
import type { PropertyRow } from '../lib/tauri'
import { getBatchProperties } from '../lib/tauri'

interface BatchPropertiesValue {
  /** Read the cached property list for a block. Returns undefined if the block isn't in the cache yet. */
  get: (blockId: string) => PropertyRow[] | undefined
  /** Whether the initial fetch is still in flight. */
  loading: boolean
  /** Trigger a refetch of the entire batch (used after mutations). */
  invalidate: (blockId: string) => void
}

const BatchPropertiesContext = createContext<BatchPropertiesValue | null>(null)

interface ProviderProps {
  /** Block IDs to fetch properties for. Order does not matter. */
  blockIds: string[]
  /**
   * Optional invalidation token — bumping this triggers a refetch of
   * the entire batch. Useful when an outer parent already owns a
   * "properties changed" signal (e.g. AgendaResults wires this to
   * `useBlockPropertyEvents().invalidationKey` + space switches).
   */
  invalidationKey?: number | string
  children: ReactNode
}

export function BatchPropertiesProvider({
  blockIds,
  invalidationKey,
  children,
}: ProviderProps): ReactElement {
  const [propertiesByBlock, setPropertiesByBlock] = useState<Map<string, PropertyRow[]>>(
    () => new Map(),
  )
  const [loading, setLoading] = useState(true)
  // Counter that bumps to force a refetch (used by `invalidate`).
  const [invalidationToken, setInvalidationToken] = useState(0)

  // Sort + join produces a stable key that only changes when the
  // membership of blockIds changes. Avoids re-fetching on every render
  // when the parent passes a new array reference but identical contents.
  const stableKey = useMemo(() => [...blockIds].sort().join('|'), [blockIds])

  // biome-ignore lint/correctness/useExhaustiveDependencies: stableKey is the membership digest of blockIds (intentional substitute for the array dep); invalidationToken / invalidationKey are manual refresh signals that don't appear inside the effect body
  useEffect(() => {
    if (blockIds.length === 0) {
      setPropertiesByBlock(new Map())
      setLoading(false)
      return
    }
    let stale = false
    setLoading(true)
    getBatchProperties(blockIds)
      .then((record) => {
        if (stale) return
        setPropertiesByBlock(new Map(Object.entries(record)))
        setLoading(false)
      })
      .catch((err) => {
        if (stale) return
        logger.warn(
          'BatchPropertiesProvider',
          'batch properties fetch failed',
          { count: blockIds.length },
          err,
        )
        setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [stableKey, invalidationToken, invalidationKey])

  const get = useCallback((blockId: string) => propertiesByBlock.get(blockId), [propertiesByBlock])
  const invalidate = useCallback((_blockId: string) => {
    // Simplest invalidation: bump the token to refetch the whole batch.
    // The `_blockId` arg is reserved for a future surgical-update API
    // (only refetch one block); for now it is unused — matches the
    // shape of `BatchAttachmentsProvider.invalidate`.
    setInvalidationToken((prev) => prev + 1)
  }, [])

  const value = useMemo<BatchPropertiesValue>(
    () => ({ get, loading, invalidate }),
    [get, loading, invalidate],
  )

  return <BatchPropertiesContext.Provider value={value}>{children}</BatchPropertiesContext.Provider>
}

export function useBatchProperties(): BatchPropertiesValue | null {
  return useContext(BatchPropertiesContext)
}
