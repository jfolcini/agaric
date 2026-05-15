/**
 * SearchResultList — listbox of search results for SearchPanel.
 *
 * PEND-30 Phase 3b — extracted from `SearchPanel.tsx` (590 → ≤450 LOC
 * orchestrator). Owns the listbox markup, per-row focus ring, and
 * breadcrumb rendering. The result-row click contract is preserved
 * exactly: `onResultClick(block)` is invoked with the original
 * `BlockRow` reference.
 *
 * Keyboard navigation lives in the parent via
 * `useListKeyboardNavigation`; this component just forwards `onKeyDown`
 * and `focusedIndex` for `aria-activedescendant` plumbing.
 */

import type { TFunction } from 'i18next'
import type React from 'react'
import { cn } from '@/lib/utils'
import type { BlockRow } from '../../lib/tauri'
import { PageLink } from '../PageLink'
import { ResultCard } from '../ResultCard'

export interface SearchResultListProps {
  results: BlockRow[]
  focusedIndex: number
  /**
   * Returns `true` if the parent handled the key event and the caller
   * should `preventDefault()` — same contract as
   * `useListKeyboardNavigation.handleKeyDown`.
   */
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => boolean
  onResultClick: (block: BlockRow) => void
  loadingResultId: string | null
  pageTitles: Map<string, string>
  t: TFunction
}

export function SearchResultList({
  results,
  focusedIndex,
  onKeyDown,
  onResultClick,
  loadingResultId,
  pageTitles,
  t,
}: SearchResultListProps): React.ReactElement | null {
  if (results.length === 0) return null

  return (
    <div
      className="search-results space-y-3 list-none m-0 p-0"
      data-testid="search-results"
      role="listbox"
      tabIndex={0}
      aria-label={t('search.resultsListLabel')}
      onKeyDown={(e) => {
        if (onKeyDown(e)) e.preventDefault()
      }}
      aria-activedescendant={
        results[focusedIndex] ? `search-result-${results[focusedIndex].id}` : undefined
      }
    >
      {results.map((block, index) => (
        <div
          key={block.id}
          id={`search-result-${block.id}`}
          role="option"
          aria-selected={index === focusedIndex}
          tabIndex={-1}
          className={cn(index === focusedIndex && 'bg-accent rounded-lg')}
        >
          <ResultCard
            block={block}
            onClick={() => onResultClick(block)}
            disabled={loadingResultId === block.id}
            showSpinner={loadingResultId === block.id}
            contentClassName="line-clamp-2"
          >
            {block.page_id && pageTitles.get(block.page_id) && (
              <p className="text-xs text-muted-foreground mt-1">
                in:{' '}
                <PageLink pageId={block.page_id} title={pageTitles.get(block.page_id) ?? ''} />
              </p>
            )}
          </ResultCard>
        </div>
      ))}
    </div>
  )
}
