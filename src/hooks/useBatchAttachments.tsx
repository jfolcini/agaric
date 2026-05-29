/**
 * useBatchAttachments — context-backed map of block_id → AttachmentRow[].
 *
 * Fetches FULL attachment lists for the given block IDs in a single IPC
 * call. Mounted once at the BlockTree level so descendant components
 * (StaticBlock for inline image preview decisions, SortableBlock for
 * paperclip badge counts) read from the shared map instead of each firing
 * their own `listAttachments` IPC.
 *
 * Outside a provider, the hook returns `null` — components that fall back
 * to per-block fetches use `useBatchAttachments()?.get(blockId) ?? []`
 * (or `?.getCount(blockId) ?? 0` for the badge-count variant).
 *
 * MAINT-131 — replaced N per-block `listAttachments` IPCs with one batched
 * query mounted at the BlockTree level. PEND-35 Tier 2.7a folded the
 * separate `BatchAttachmentCountsProvider` into this provider: counts are
 * derived as `rows.length`, eliminating a redundant Tauri command, IPC,
 * specta binding, and tauri-mock handler.
 *
 * ## Cache invalidation
 *
 * When `useBlockAttachments` mutates (handleAddAttachment /
 * handleDeleteAttachment), it calls the provider's `invalidate(blockId)`
 * method which triggers a refetch of the entire batch (cheap — same SQL
 * query, just stale data refresh). This keeps StaticBlock's batch-derived
 * view consistent with the AttachmentList drawer's local state.
 */

import type { ReactElement, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { logger } from '../lib/logger'
import type { AttachmentRow } from '../lib/tauri'
import { getBatchAttachments } from '../lib/tauri'

interface BatchAttachmentsValue {
  /** Read the cached attachment list for a block. Returns undefined if the block isn't in the cache. */
  get: (blockId: string) => AttachmentRow[] | undefined
  /**
   * Read the cached attachment count for a block. Returns 0 when the block
   * is absent from the cache (no attachments OR the initial fetch is still
   * pending). Derived as `rows.length` from the same map `get` reads —
   * PEND-35 Tier 2.7a collapsed the separate count batch into this hook.
   */
  getCount: (blockId: string) => number
  /** Whether the initial fetch is still in flight. */
  loading: boolean
  /** Trigger a refetch of the entire batch (used after add/delete mutations). */
  invalidate: (blockId: string) => void
}

const BatchAttachmentsContext = createContext<BatchAttachmentsValue | null>(null)

interface ProviderProps {
  /** Block IDs to fetch attachments for. Order does not matter. */
  blockIds: string[]
  children: ReactNode
}

export function BatchAttachmentsProvider({ blockIds, children }: ProviderProps): ReactElement {
  const [attachmentsByBlock, setAttachmentsByBlock] = useState<Map<string, AttachmentRow[]>>(
    () => new Map(),
  )
  const [loading, setLoading] = useState(true)
  // Counter that bumps to force a refetch (used by `invalidate`).
  const [invalidationToken, setInvalidationToken] = useState(0)

  // Sort + join produces a stable key that only changes when the
  // membership of blockIds changes. Avoids re-fetching on every render
  // when the parent passes a new array reference but identical contents.
  const stableKey = useMemo(() => [...blockIds].sort().join('|'), [blockIds])

  useEffect(() => {
    if (blockIds.length === 0) {
      setAttachmentsByBlock(new Map())
      setLoading(false)
      return
    }
    let stale = false
    setLoading(true)
    getBatchAttachments(blockIds)
      .then((record) => {
        if (stale) return
        setAttachmentsByBlock(new Map(Object.entries(record)))
        setLoading(false)
      })
      .catch((err) => {
        if (stale) return
        logger.warn(
          'BatchAttachmentsProvider',
          'batch attachments fetch failed',
          { count: blockIds.length },
          err,
        )
        setLoading(false)
      })
    return () => {
      stale = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- blockIds/blockIds.length are read inside the effect, but stableKey is their membership digest (intentional substitute for the array dep); depending on blockIds directly would refetch on every reallocation with identical contents. invalidationToken is a manual refresh signal.
  }, [stableKey, invalidationToken])

  const get = useCallback(
    (blockId: string) => attachmentsByBlock.get(blockId),
    [attachmentsByBlock],
  )
  const getCount = useCallback(
    // O(1) — `Map.get` then `Array.length`. Returns 0 for blocks absent
    // from the cache (no attachments OR initial fetch still pending),
    // matching the previous BatchAttachmentCountsProvider semantics.
    (blockId: string) => attachmentsByBlock.get(blockId)?.length ?? 0,
    [attachmentsByBlock],
  )
  const invalidate = useCallback((_blockId: string) => {
    // Simplest invalidation: bump the token to refetch the whole batch.
    // The `_blockId` arg is reserved for a future surgical-update API
    // (only refetch one block); for now it is unused.
    setInvalidationToken((prev) => prev + 1)
  }, [])

  const value = useMemo<BatchAttachmentsValue>(
    () => ({ get, getCount, loading, invalidate }),
    [get, getCount, loading, invalidate],
  )

  return (
    <BatchAttachmentsContext.Provider value={value}>{children}</BatchAttachmentsContext.Provider>
  )
}

export function useBatchAttachments(): BatchAttachmentsValue | null {
  return useContext(BatchAttachmentsContext)
}
