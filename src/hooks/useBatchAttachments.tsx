/**
 * useBatchAttachments — context-backed map of block_id → AttachmentRow[].
 *
 * Fetches FULL attachment lists for the given block IDs in a single IPC
 * call. Mounted once at the BlockTree level so descendant components
 * (StaticBlock for inline image preview decisions) read from the shared
 * map instead of each firing their own `listAttachments` IPC.
 *
 * Outside a provider, the hook returns `null` — components that fall back
 * to per-block fetches use `useBatchAttachments()?.get(blockId) ?? []`.
 *
 * MAINT-131 — closes the StaticBlock per-row IPC half. Pairs with
 * `useBatchAttachmentCounts` (badge counts) from session 572.
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: stableKey is the membership digest of blockIds (intentional substitute for the array dep); invalidationToken is a manual refresh signal that doesn't appear inside the effect body
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
  }, [stableKey, invalidationToken])

  const get = useCallback(
    (blockId: string) => attachmentsByBlock.get(blockId),
    [attachmentsByBlock],
  )
  const invalidate = useCallback((_blockId: string) => {
    // Simplest invalidation: bump the token to refetch the whole batch.
    // The `_blockId` arg is reserved for a future surgical-update API
    // (only refetch one block); for now it is unused.
    setInvalidationToken((prev) => prev + 1)
  }, [])

  const value = useMemo<BatchAttachmentsValue>(
    () => ({ get, loading, invalidate }),
    [get, loading, invalidate],
  )

  return (
    <BatchAttachmentsContext.Provider value={value}>{children}</BatchAttachmentsContext.Provider>
  )
}

export function useBatchAttachments(): BatchAttachmentsValue | null {
  return useContext(BatchAttachmentsContext)
}
