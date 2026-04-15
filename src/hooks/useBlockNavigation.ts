/**
 * useBlockNavigation — shared click/keyboard handlers for navigating to a
 * block's parent page.
 *
 * Returns `handleBlockClick` and `handleBlockKeyDown` that DonePanel,
 * DuePanel, and AgendaResults use on their block list items. Handles
 * Enter/Space keydown → click delegation and resolves the parent page
 * title from a provided `pageTitles` map.
 */

import type React from 'react'
import { useCallback } from 'react'
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

export interface UseBlockNavigationReturn {
  /** Click handler: navigates to the block's parent page. */
  handleBlockClick: (block: BlockRow) => void
  /** KeyDown handler: delegates Enter/Space to handleBlockClick. */
  handleBlockKeyDown: (e: React.KeyboardEvent, block: BlockRow) => void
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

  return { handleBlockClick, handleBlockKeyDown }
}
