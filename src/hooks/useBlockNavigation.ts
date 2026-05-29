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

import type { NavigateToPageFn } from '../lib/block-events'
import type { BlockRow } from '../lib/tauri'

export interface UseBlockNavigationOptions {
  /** Navigation callback — receives (pageId, title, blockId). */
  onNavigateToPage?: NavigateToPageFn | undefined
  /** Map of page IDs to resolved titles for breadcrumbs. */
  pageTitles: Map<string, string>
  /** Fallback title when the page ID is not in pageTitles. Defaults to "Untitled". */
  untitledLabel?: string | undefined
}

/** Per-row handler bundle: stable function identities, keyed by block id. */
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
   * functions across renders for the same block id. Required so
   * `BlockListItem`'s `React.memo` can actually drop re-renders.
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
  const getRowHandlers = useMemo(() => {
    const cache = new Map<string, BlockRowHandlers>()
    return (block: BlockRow): BlockRowHandlers => {
      let entry = cache.get(block.id)
      if (!entry) {
        entry = {
          onClick: () => handleBlockClick(block),
          onKeyDown: (e: React.KeyboardEvent) => handleBlockKeyDown(e, block),
        }
        cache.set(block.id, entry)
      }
      return entry
    }
  }, [handleBlockClick, handleBlockKeyDown])

  return { handleBlockClick, handleBlockKeyDown, getRowHandlers }
}
