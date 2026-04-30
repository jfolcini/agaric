/**
 * useBatchAttachmentCounts — context-backed map of block_id → attachment count.
 *
 * Fetches all attachment counts for the given block IDs in a single IPC
 * call. Mounted once at the BlockTree level so that descendant components
 * (SortableBlock badge counts) read from the shared map instead of each
 * firing their own `listAttachments` IPC.
 *
 * Outside a provider, the hook returns `null` — components that fall back
 * to per-block fetches use `useBatchAttachmentCounts()?.get(blockId) ?? 0`.
 *
 * MAINT-131 — primary fix for the doubled-IPC-per-block-row problem.
 */

import type { ReactElement, ReactNode } from 'react'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { logger } from '../lib/logger'
import { getBatchAttachmentCounts } from '../lib/tauri'

const BatchAttachmentCountsContext = createContext<Map<string, number> | null>(null)

interface ProviderProps {
  /** Block IDs to fetch counts for. Order does not matter; the hook
   * sorts internally to produce a stable refetch key. */
  blockIds: string[]
  children: ReactNode
}

/**
 * Fetches batch attachment counts and publishes the resulting map to
 * descendants. Re-fetches when `blockIds` membership changes (sorted
 * lexicographically and joined to produce a stable hash).
 */
export function BatchAttachmentCountsProvider({ blockIds, children }: ProviderProps): ReactElement {
  const [counts, setCounts] = useState<Map<string, number>>(() => new Map())

  // Sort + join produces a stable key that only changes when the
  // membership of blockIds changes. Avoids re-fetching on every render
  // when the parent passes a new array reference but identical contents.
  const stableKey = useMemo(() => [...blockIds].sort().join('|'), [blockIds])

  // biome-ignore lint/correctness/useExhaustiveDependencies: stableKey is the membership digest of blockIds; deps tracked via the digest, not the array identity
  useEffect(() => {
    if (blockIds.length === 0) {
      setCounts(new Map())
      return
    }
    let stale = false
    getBatchAttachmentCounts(blockIds)
      .then((record) => {
        if (stale) return
        setCounts(new Map(Object.entries(record)))
      })
      .catch((err) => {
        logger.warn(
          'BatchAttachmentCountsProvider',
          'batch attachment counts failed',
          { count: blockIds.length },
          err,
        )
      })
    return () => {
      stale = true
    }
  }, [stableKey])

  return (
    <BatchAttachmentCountsContext.Provider value={counts}>
      {children}
    </BatchAttachmentCountsContext.Provider>
  )
}

/**
 * Read the published batch attachment counts map. Returns `null` when no
 * provider wraps the consumer. Use `useBatchAttachmentCounts()?.get(blockId) ?? 0`
 * for the fallback-to-zero pattern.
 */
export function useBatchAttachmentCounts(): Map<string, number> | null {
  return useContext(BatchAttachmentCountsContext)
}
