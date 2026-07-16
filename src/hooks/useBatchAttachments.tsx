/**
 * useBatchAttachments — context-backed map of block_id → AttachmentRow[].
 *
 * Fetches attachment lists for block IDs not already cached in a single IPC
 * call. Mounted once at the BlockTree level so descendant components
 * (StaticBlock for inline image preview decisions, SortableBlock for
 * paperclip badge counts) read from the shared map instead of each firing
 * their own `listAttachments` IPC.
 *
 * Outside a provider, the hook returns `null` — components that fall back
 * to per-block fetches use `useBatchAttachments()?.get(blockId) ?? []`
 * (or `?.getCount(blockId) ?? 0` for the badge-count variant).
 *
 * Replaced N per-block `listAttachments` IPCs with one batched
 * Query mounted at the BlockTree level. folded the
 * separate `BatchAttachmentCountsProvider` into this provider: counts are
 * derived as `rows.length`, eliminating a redundant Tauri command, IPC,
 * specta binding, and tauri-mock handler.
 *
 * ## Delta fetching (#2701)
 *
 * `blockIds` is the scroll-windowed set (see `useViewportWindow`), so its
 * membership changes on almost every scroll settle even though ~90% of the
 * ids were already resolved a moment earlier. A persistent `cacheRef` (keyed
 * by block id, never cleared on window membership changes — only on
 * `invalidate()`) lets the fetch effect issue `getBatchAttachments` for only
 * the ids NOT already cached. A block that scrolls out of the window and
 * back in is served from the cache with no refetch; a block scrolled out
 * permanently just isn't part of the next id set — its cache entry lingers
 * harmlessly (bounded by the total ids ever seen this session).
 *
 * ## Cache invalidation
 *
 * When `useBlockAttachments` mutates (handleAddAttachment /
 * handleDeleteAttachment), it calls the provider's `invalidate(blockId)`
 * method which refetches the current window AND purges any cached id
 * outside the window (cheap — same SQL query, just stale data refresh).
 * The purge matters because `invalidate()` carries no id-scoping guarantee
 * beyond the window it refetches; a stale off-window entry would otherwise
 * survive until the next invalidation happens to catch that id back in the
 * window. This keeps StaticBlock's batch-derived view consistent with the
 * AttachmentList drawer's local state.
 */

import type { ReactElement, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { logger } from '@/lib/logger'
import type { AttachmentRow } from '@/lib/tauri'
import { getBatchAttachments } from '@/lib/tauri'

interface BatchAttachmentsValue {
  /**
   * Read the cached attachment list for a block. Returns `undefined` iff the
   * block has never been part of a completed fetch (initial fetch pending,
   * or the id hasn't entered the window yet). A block that WAS fetched and
   * has no attachments reads as `[]` (#2701) — the delta-fetch cache needs
   * this distinction to know which windowed ids are safe to skip refetching.
   */
  get: (blockId: string) => AttachmentRow[] | undefined
  /**
   * Read the cached attachment count for a block. Returns 0 when the block
   * is absent from the cache (no attachments OR the initial fetch is still
   * pending). Derived as `rows.length` from the same map `get` reads —
   * Collapsed the separate count batch into this hook.
   */
  getCount: (blockId: string) => number
  /** Trigger a refetch of the entire batch (used after add/delete mutations). */
  invalidate: (blockId: string) => void
}

const BatchAttachmentsContext = createContext<BatchAttachmentsValue | null>(null)

// Split from `BatchAttachmentsValue` (#2701) so consumers that only read
// `get`/`getCount`/`invalidate` (SortableBlock's paperclip badge,
// StaticBlockAttachments) don't re-render on the loading:false→true→false
// blip around every fetch — only consumers that call
// `useBatchAttachmentsLoading()` do. Outside a provider this defaults to
// `false` (nothing is loading if nothing is fetching).
const BatchAttachmentsLoadingContext = createContext<boolean>(false)

interface ProviderProps {
  /** Block IDs to fetch attachments for. Order does not matter. */
  blockIds: string[]
  children: ReactNode
}

/**
 * True iff two `AttachmentRow`s are field-wise equal. `AttachmentRow` is a
 * flat POJO (no nested objects), so a shallow field comparison is sufficient.
 */
function attachmentRowEqual(a: AttachmentRow, b: AttachmentRow): boolean {
  return (
    a.id === b.id &&
    a.block_id === b.block_id &&
    a.filename === b.filename &&
    a.mime_type === b.mime_type &&
    a.size_bytes === b.size_bytes &&
    a.fs_path === b.fs_path &&
    a.created_at === b.created_at
  )
}

function rowsEqual(a: readonly AttachmentRow[], b: readonly AttachmentRow[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ae = a[i]
    const be = b[i]
    if (ae == null || be == null || !attachmentRowEqual(ae, be)) return false
  }
  return true
}

/**
 * Merges a fetch response for `fetchedIds` into `cache`, skipping ids whose
 * new rows are element-wise equal to the cached ones (so an `invalidate()`
 * refetch that returns byte-identical data doesn't allocate a new Map or
 * trigger a context-value churn for that id). `changed` is false only when
 * every fetched id's rows matched the cache exactly (or all ids were new
 * — always considered a change).
 */
function mergeFetchedIntoCache(
  cache: Map<string, AttachmentRow[]>,
  fetchedIds: readonly string[],
  record: Record<string, AttachmentRow[]>,
): { map: Map<string, AttachmentRow[]>; changed: boolean } {
  let changed = false
  const next = new Map(cache)
  for (const id of fetchedIds) {
    const rows = record[id] ?? []
    const prior = next.get(id)
    if (prior !== undefined && rowsEqual(prior, rows)) continue
    next.set(id, rows)
    changed = true
  }
  return { map: changed ? next : cache, changed }
}

export function BatchAttachmentsProvider({ blockIds, children }: ProviderProps): ReactElement {
  const [attachmentsByBlock, setAttachmentsByBlock] = useState<Map<string, AttachmentRow[]>>(
    () => new Map(),
  )
  const [loading, setLoading] = useState(true)
  // Counter that bumps to force a refetch (used by `invalidate`).
  const [invalidationToken, setInvalidationToken] = useState(0)

  // Persistent id → rows cache. Unlike `attachmentsByBlock` (the rendered
  // state), this is NEVER reset when the window shrinks/moves — only
  // `invalidate()` clears it. It is the source of truth for "already
  // fetched" membership, read synchronously inside the effect below.
  const cacheRef = useRef<Map<string, AttachmentRow[]>>(new Map())
  const lastInvalidationTokenRef = useRef(invalidationToken)

  // Sort + join produces a stable key that only changes when the
  // membership of blockIds changes. Avoids re-fetching on every render
  // when the parent passes a new array reference but identical contents.
  const stableKey = useMemo(() => [...blockIds].toSorted().join('|'), [blockIds])

  useEffect(() => {
    if (blockIds.length === 0) {
      // Nothing to show, but keep the cache — a subsequent non-empty window
      // may re-include ids already resolved (e.g. transient empty window
      // during a page swap).
      setLoading(false)
      return
    }

    // `invalidate()` bumped the token since the last run — force a refetch
    // of every currently-windowed id (preserves the pre-#2701 whole-batch
    // refresh semantics) rather than only the ones missing from the cache.
    // The OLD cached rows are still used for comparison below, so an
    // invalidate that returns byte-identical data for an id still skips
    // the Map replacement for that id.
    const forceRefetch = invalidationToken !== lastInvalidationTokenRef.current
    lastInvalidationTokenRef.current = invalidationToken

    if (forceRefetch) {
      // `invalidate()` has no id-scoping — it's a blanket "something
      // mutated" signal, and only the CURRENT window gets refetched below.
      // A cached id currently OUTSIDE the window can no longer be trusted
      // (the mutation that triggered this invalidate may be for exactly
      // that id, e.g. an add/delete on a block that has since scrolled out
      // of view). Purge off-window entries so a later scroll back in
      // refetches fresh instead of silently serving a value that may
      // predate this invalidation (#2701 staleness fix).
      const windowed = new Set(blockIds)
      for (const id of cacheRef.current.keys()) {
        if (!windowed.has(id)) cacheRef.current.delete(id)
      }
    }

    const idsToFetch = forceRefetch ? blockIds : blockIds.filter((id) => !cacheRef.current.has(id))
    if (idsToFetch.length === 0) {
      // Every windowed id is already cached (scroll within already-visited
      // territory, or a reorder within the same set) — no IPC, no state
      // churn.
      return
    }

    let stale = false
    setLoading(true)
    getBatchAttachments(idsToFetch)
      .then((record) => {
        if (stale) return
        const { map, changed } = mergeFetchedIntoCache(cacheRef.current, idsToFetch, record)
        cacheRef.current = map
        if (changed) setAttachmentsByBlock(map)
        setLoading(false)
      })
      .catch((err) => {
        if (stale) return
        logger.warn(
          'BatchAttachmentsProvider',
          'batch attachments fetch failed',
          { count: idsToFetch.length },
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

  // `loading` is deliberately NOT in this memoized value (#2701) — see
  // `BatchAttachmentsLoadingContext` above. This value only changes when
  // `attachmentsByBlock` is actually replaced with new content, i.e. once
  // per fetch that returns new data — not on the loading:true blip that
  // precedes it.
  const value = useMemo<BatchAttachmentsValue>(
    () => ({ get, getCount, invalidate }),
    [get, getCount, invalidate],
  )

  return (
    <BatchAttachmentsContext.Provider value={value}>
      <BatchAttachmentsLoadingContext.Provider value={loading}>
        {children}
      </BatchAttachmentsLoadingContext.Provider>
    </BatchAttachmentsContext.Provider>
  )
}

export function useBatchAttachments(): BatchAttachmentsValue | null {
  return useContext(BatchAttachmentsContext)
}

/**
 * Whether the provider's initial fetch or a refetch (window growth /
 * `invalidate()`) is in flight. Split out of `useBatchAttachments()`'s
 * value (#2701) so only consumers that actually need the loading state
 * subscribe to its churn. Returns `false` outside a provider.
 */
export function useBatchAttachmentsLoading(): boolean {
  return useContext(BatchAttachmentsLoadingContext)
}
