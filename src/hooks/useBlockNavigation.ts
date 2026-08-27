/**
 * useBlockNavigation — shared click/keyboard handlers for navigating to a
 * block's parent page.
 *
 * Returns `handleBlockClick` and `handleBlockKeyDown` that DonePanel,
 * DuePanel, and AgendaResults use on their block list items. Handles
 * Enter/Space keydown → click delegation and resolves the parent page
 * title from a provided `pageTitles` map.
 *
 * Tier 1.4 (perf-review 2026-05-09): also exposes `getRowHandlers(block)` —
 * a memoed factory that returns per-block stable `onClick`/`onKeyDown`
 * functions. Without this, every parent render of a panel allocates fresh
 * inline arrows (`onClick={() => handleBlockClick(block)}`) per row,
 * defeating the `React.memo` wrapping `BlockListItem`. Using
 * `getRowHandlers(block)` returns the same function instances across
 * renders as long as the underlying click/keydown callbacks are stable.
 */

import type React from 'react'
import { useCallback, useMemo } from 'react'

import type { BlockRow } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'

export interface UseBlockNavigationOptions {
  /** Navigation callback — receives (pageId, title, blockId). */
  onNavigateToPage?: NavigateToPageFn | undefined
  /** Map of page IDs to resolved titles for breadcrumbs. */
  pageTitles: Map<string, string>
  /** Fallback title when the page ID is not in pageTitles. Defaults to "Untitled". */
  untitledLabel?: string | undefined
}

/** Per-row handler bundle: stable function identities, keyed by (block id, page id). */
export interface BlockRowHandlers {
  onClick: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

export interface UseBlockNavigationReturn {
  /** Click handler: navigates to the block's parent page. */
  handleBlockClick: (block: BlockRow) => void
  /** KeyDown handler: delegates Enter/Space to handleBlockClick. */
  handleBlockKeyDown: (e: React.KeyboardEvent, block: BlockRow) => void
  /**
   * Stable per-block handler factory — returns the same `onClick`/`onKeyDown`
   * functions across renders for the same (block id, page id) pair. Required
   * so `BlockListItem`'s `React.memo` can actually drop re-renders. A row
   * whose `page_id` has changed gets a fresh bundle rather than a closure
   * still pointing at the old page.
   */
  getRowHandlers: (block: BlockRow) => BlockRowHandlers
}

export function useBlockNavigation({
  onNavigateToPage,
  pageTitles,
  untitledLabel = 'Untitled',
}: UseBlockNavigationOptions): UseBlockNavigationReturn {
  const handleBlockClick = useCallback(
    (block: BlockRow) => {
      const pageId = block.page_id
      if (pageId) {
        const title = pageTitles.get(pageId) ?? untitledLabel
        onNavigateToPage?.(pageId, title, block.id)
      }
    },
    [onNavigateToPage, pageTitles, untitledLabel],
  )

  const handleBlockKeyDown = useCallback(
    (e: React.KeyboardEvent, block: BlockRow) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleBlockClick(block)
      }
    },
    [handleBlockClick],
  )

  // Tier 1.4: per-block stable handlers. Cache is invalidated whenever the
  // underlying click/keydown callbacks change identity (which themselves
  // only change when onNavigateToPage / pageTitles / untitledLabel change).
  //
  // The cache key is (block.id, block.page_id), not block.id alone. The
  // cached closures capture the whole `block`, but the only fields they can
  // ever observe are `block.id` and `block.page_id` (handleBlockKeyDown
  // delegates to handleBlockClick, which reads exactly those two). Keying on
  // the id alone made a same-id row whose `page_id` had changed keep
  // navigating with the stale capture — reachable in AgendaResults, where
  // page-title resolution runs in an async effect AFTER the render that first
  // shows the moved row, so `pageTitles` (and with it the whole cache) is not
  // replaced until the batchResolve IPC comes back. Including page_id in the
  // key closes that window and makes the entry a genuine function of its key.
  const getRowHandlers = useMemo(() => {
    const cache = new Map<string, BlockRowHandlers>()
    return (block: BlockRow): BlockRowHandlers => {
      // NUL separator: neither a ULID nor a page id can contain one, so the
      // composite key cannot collide with a different (id, page_id) pair.
      const key = `${block.id}\u0000${block.page_id ?? ''}`
      let entry = cache.get(key)
      if (!entry) {
        entry = {
          onClick: () => handleBlockClick(block),
          onKeyDown: (e: React.KeyboardEvent) => handleBlockKeyDown(e, block),
        }
        // oxlint-disable-next-line react/immutability -- `cache` is a Map allocated once (per handleBlockClick/handleBlockKeyDown identity) and only ever grown with entries that are a pure, deterministic function of the key (block.id, block.page_id) plus the two captured callbacks; a discarded/duplicate render (StrictMode double-invoke, an interrupted concurrent render) only recomputes a behaviourally identical entry for the same key, so this mutation is idempotent and produces no observable difference (#4409)
        cache.set(key, entry)
      }
      return entry
    }
  }, [handleBlockClick, handleBlockKeyDown])

  return { handleBlockClick, handleBlockKeyDown, getRowHandlers }
}
