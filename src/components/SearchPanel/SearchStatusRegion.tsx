/**
 * SearchStatusRegion — aria-live region announcing search status.
 *
 * PEND-30 Phase 3b — extracted from `SearchPanel.tsx` to keep the
 * orchestrator under 450 LOC. Owns the `role="status"` region and the
 * `getSearchStatusText` helper that decides what to announce.
 *
 * UX-269 / UX-335 — the region sits ABOVE the listbox as a separate
 * sibling (NOT wrapping it) so interactive options aren't re-announced
 * on every result-set change. Pre-search stays silent (nothing to
 * announce yet); UX-5 added a polite "Searching…" announcement while a
 * search is in flight.
 */

import type { TFunction } from 'i18next'
import type React from 'react'

export interface SearchStatusRegionProps {
  searched: boolean
  searchLoading: boolean
  error: string | null
  /**
   * UX-A2 — non-null when the failure is an invalid regex. The specific
   * regex message is already announced via the header alert next to the
   * input, so the generic "Search failed" status branch is suppressed
   * here to avoid a double announcement to screen readers.
   */
  regexError: string | null
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
  const { searched, searchLoading, error, regexError, cleared, resultCount } = args
  // UX-5 — announce that a search is running. Screen-reader users
  // otherwise got silence between submit and the result count. The
  // region is a sibling of (not a wrapper around) the listbox, so this
  // does not re-announce result options.
  if (searched && searchLoading) {
    return t('search.searching')
  }
  // UX-2 — announce generic search failures. Without this branch a
  // non-regex error left the live region (and the panel) silent/blank.
  // UX-A2 — but DON'T announce the generic failure for an invalid-regex
  // error: that case already surfaces its specific message in the header
  // alert, and announcing both here would double-announce.
  if (searched && !searchLoading && error && regexError == null) {
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
  regexError,
  cleared,
  resultCount,
  t,
}: SearchStatusRegionProps): React.ReactElement {
  const statusText = getSearchStatusText(
    { searched, searchLoading, error, regexError, cleared, resultCount },
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
