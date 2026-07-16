/**
 * useBatchPropertyRows — context-backed map of block_id → PropertyRow[].
 *
 * Fetches property lists for block IDs not already cached in a single
 * `getBatchProperties` IPC. Mounted at the parent that knows the full
 * `blockIds` set (e.g. `AgendaResults`) so descendant components
 * (`DependencyIndicator` per row) read from the shared map instead of
 * each firing their own `getProperties` IPC on initial mount.
 *
 * Outside a provider, the hook returns `null` — components that fall
 * back to per-block fetches use `useBatchPropertyRows()?.get(blockId)`.
 *
 * Collapses the per-row `getProperties` fan-out in
 * `DependencyIndicator` (which previously dedup'd only RE-RENDERS via a
 * shared cache ref, not the initial mount fan-out for N rows) into a
 * single batched query mounted at the AgendaResults level. Mirror of
 * `BatchAttachmentsProvider` (Tier 2.7).
 *
 * ## Delta fetching (#2701)
 *
 * `blockIds` is often the scroll-windowed set (BlockTree), so its
 * membership changes on almost every scroll settle even though most of the
 * ids were already resolved a moment earlier. A persistent `cacheRef` (keyed
 * by block id, never cleared on window membership changes) lets the fetch
 * effect issue `getBatchProperties` for only the ids NOT already cached. An
 * `invalidate()` call or `invalidationKey` bump forces a refetch of the
 * current window AND purges any cached id outside the window, since neither
 * signal is id-scoped — the mutation that triggered it may belong to an
 * id that isn't currently windowed, and only the window gets refetched.
 */

import type { ReactElement, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { logger } from '@/lib/logger'
import type { PropertyRow } from '@/lib/tauri'
import { getBatchProperties } from '@/lib/tauri'

interface BatchPropertiesValue {
  /**
   * Read the cached property list for a block. Returns `undefined` iff the
   * block has never been part of a completed fetch (initial fetch pending,
   * or the id hasn't entered the window yet). A block that WAS fetched and
   * has no properties reads as `[]` (#2701) — the delta-fetch cache needs
   * this distinction to know which windowed ids are safe to skip refetching.
   */
  get: (blockId: string) => PropertyRow[] | undefined
  /** Trigger a refetch of the entire batch (used after mutations). */
  invalidate: (blockId: string) => void
}

const BatchPropertiesContext = createContext<BatchPropertiesValue | null>(null)

// Split from `BatchPropertiesValue` (#2701) so consumers that only read
// `get`/`invalidate` (`useExtraBlockProperties`) don't re-render on the
// loading:false→true→false blip around every fetch — only consumers that
// call `useBatchPropertyRowsLoading()` do. Outside a provider this
// defaults to `false` (nothing is loading if nothing is fetching).
const BatchPropertiesLoadingContext = createContext<boolean>(false)

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

/**
 * True iff two `PropertyRow`s are field-wise equal. `PropertyRow` is a flat
 * POJO (no nested objects), so a shallow field comparison is sufficient.
 */
function propertyRowEqual(a: PropertyRow, b: PropertyRow): boolean {
  return (
    a.key === b.key &&
    a.value_text === b.value_text &&
    a.value_num === b.value_num &&
    a.value_date === b.value_date &&
    a.value_ref === b.value_ref &&
    a.value_bool === b.value_bool
  )
}

function rowsEqual(a: readonly PropertyRow[], b: readonly PropertyRow[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ae = a[i]
    const be = b[i]
    if (ae == null || be == null || !propertyRowEqual(ae, be)) return false
  }
  return true
}

/**
 * Merges a fetch response for `fetchedIds` into `cache`, skipping ids whose
 * new rows are element-wise equal to the cached ones (so an invalidation
 * refetch that returns byte-identical data doesn't allocate a new Map or
 * trigger a context-value churn for that id).
 */
function mergeFetchedIntoCache(
  cache: Map<string, PropertyRow[]>,
  fetchedIds: readonly string[],
  record: Record<string, PropertyRow[]>,
): { map: Map<string, PropertyRow[]>; changed: boolean } {
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

  // Persistent id → rows cache. Unlike `propertiesByBlock` (the rendered
  // state), this is NEVER reset when the window shrinks/moves — only an
  // invalidation (token bump or `invalidationKey` change) clears the
  // relevant entries. It is the source of truth for "already fetched"
  // membership, read synchronously inside the effect below.
  const cacheRef = useRef<Map<string, PropertyRow[]>>(new Map())
  const lastInvalidationSignalRef = useRef(`${invalidationToken}|${invalidationKey ?? ''}`)

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

    // `invalidate()` bumped the token, or the caller's `invalidationKey`
    // changed (e.g. a `block:properties-changed` event or a space switch)
    // since the last run — force a refetch of every currently-windowed id
    // (preserves the pre-#2701 whole-batch refresh semantics) rather than
    // only the ones missing from the cache. The OLD cached rows are still
    // used for comparison below, so a refetch that returns byte-identical
    // data for an id still skips the Map replacement for that id.
    const invalidationSignal = `${invalidationToken}|${invalidationKey ?? ''}`
    const forceRefetch = invalidationSignal !== lastInvalidationSignalRef.current
    lastInvalidationSignalRef.current = invalidationSignal

    if (forceRefetch) {
      // Both `invalidate()` and `invalidationKey` (the debounced, GLOBAL
      // `block:properties-changed` counter — it fires for ANY block's
      // property mutation anywhere, not just windowed ones) are blanket
      // "something mutated" signals with no id-scoping, and only the
      // CURRENT window gets refetched below. A cached id currently OUTSIDE
      // the window can no longer be trusted — the edit that triggered this
      // invalidation may be for exactly that id. Purge off-window entries
      // so a later scroll back in refetches fresh instead of silently
      // serving a value that may predate this invalidation (#2701
      // staleness fix).
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
    getBatchProperties(idsToFetch)
      .then((record) => {
        if (stale) return
        const { map, changed } = mergeFetchedIntoCache(cacheRef.current, idsToFetch, record)
        cacheRef.current = map
        if (changed) setPropertiesByBlock(map)
        setLoading(false)
      })
      .catch((err) => {
        if (stale) return
        logger.warn(
          'BatchPropertiesProvider',
          'batch properties fetch failed',
          { count: idsToFetch.length },
          err,
        )
        setLoading(false)
      })
    return () => {
      stale = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- blockIds/blockIds.length are read inside the effect, but stableKey is their membership digest (intentional substitute for the array dep); depending on blockIds directly would refetch on every reallocation with identical contents. invalidationToken/invalidationKey are manual refresh signals.
  }, [stableKey, invalidationToken, invalidationKey])

  const get = useCallback((blockId: string) => propertiesByBlock.get(blockId), [propertiesByBlock])
  const invalidate = useCallback((_blockId: string) => {
    // Simplest invalidation: bump the token to refetch the whole batch.
    // The `_blockId` arg is reserved for a future surgical-update API
    // (only refetch one block); for now it is unused — matches the
    // shape of `BatchAttachmentsProvider.invalidate`.
    setInvalidationToken((prev) => prev + 1)
  }, [])

  // `loading` is deliberately NOT in this memoized value (#2701) — see
  // `BatchPropertiesLoadingContext` above. This value only changes when
  // `propertiesByBlock` is actually replaced with new content, i.e. once
  // per fetch that returns new data — not on the loading:true blip that
  // precedes it.
  const value = useMemo<BatchPropertiesValue>(() => ({ get, invalidate }), [get, invalidate])

  return (
    <BatchPropertiesContext.Provider value={value}>
      <BatchPropertiesLoadingContext.Provider value={loading}>
        {children}
      </BatchPropertiesLoadingContext.Provider>
    </BatchPropertiesContext.Provider>
  )
}

export function useBatchPropertyRows(): BatchPropertiesValue | null {
  return useContext(BatchPropertiesContext)
}

/**
 * Whether the provider's initial fetch or a refetch (window growth /
 * `invalidate()` / `invalidationKey` bump) is in flight. Split out of
 * `useBatchPropertyRows()`'s value (#2701) so only consumers that actually
 * need the loading state subscribe to its churn. Returns `false` outside a
 * provider.
 */
export function useBatchPropertyRowsLoading(): boolean {
  return useContext(BatchPropertiesLoadingContext)
}
