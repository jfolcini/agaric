/**
 * SearchStatusRegion — aria-live region announcing search status.
 *
 * PEND-30 Phase 3b — extracted from `SearchPanel.tsx` to keep the
 * orchestrator under 450 LOC. Owns the `role="status"` region and the
 * `getSearchStatusText` helper that decides what to announce.
 *
 * UX-269 / UX-335 — the region sits ABOVE the listbox as a separate
 * sibling (NOT wrapping it) so interactive options aren't re-announced
 * on every result-set change. Pre-search and loading states stay
 * silent intentionally — there's no relevant change to announce.
 */

import type { TFunction } from 'i18next'
import type React from 'react'

export interface SearchStatusRegionProps {
  searched: boolean
  searchLoading: boolean
  error: string | null
  cleared: boolean
  resultCount: number
  t: TFunction
}

/**
 * UX-335 — Compute the live-region status text. Returns `null` when
 * the region should stay empty (pre-search / loading). Exported for
 * direct testing.
 */
export function getSearchStatusText(
  args: Omit<SearchStatusRegionProps, 't'>,
  t: TFunction,
): string | null {
  const { searched, searchLoading, error, cleared, resultCount } = args
  // UX-2 — announce generic search failures. Without this branch a
  // non-regex error left the live region (and the panel) silent/blank.
  if (searched && !searchLoading && error) {
    return t('search.statusError')
  }
  if (searched && !searchLoading && !error && resultCount > 0) {
    return t('search.resultsCount', { count: resultCount })
  }
  if (searched && !searchLoading && !error && resultCount === 0) {
    return t('search.statusNoResults')
  }
  if (cleared && !searchLoading) {
    return t('search.statusCleared')
  }
  return null
}

export function SearchStatusRegion({
  searched,
  searchLoading,
  error,
  cleared,
  resultCount,
  t,
}: SearchStatusRegionProps): React.ReactElement {
  const statusText = getSearchStatusText(
    { searched, searchLoading, error, cleared, resultCount },
    t,
  )
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-testid="search-results-status">
      {statusText !== null && (
        <span className="text-xs text-muted-foreground" data-testid="search-results-count">
          {statusText}
        </span>
      )}
    </div>
  )
}
