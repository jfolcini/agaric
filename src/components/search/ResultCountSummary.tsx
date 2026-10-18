/**
 * ResultCountSummary — "N matches in M pages" header above the first
 * Search-result group (Phase 1).
 *
 * Empty result counts render nothing — the SearchPanel surfaces
 * `search.noResultsFound` elsewhere when `searched && !loading &&
 * results.length === 0`. Matches and pages are two independent quantities,
 * so each gets its own `_one` / `_other` key and the page phrase is
 * interpolated into the match phrase.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

export interface ResultCountSummaryProps {
  /** Total matching blocks across all groups. */
  matchCount: number
  /** Total distinct pages containing at least one match. */
  pageCount: number
}

export function ResultCountSummary({
  matchCount,
  pageCount,
}: ResultCountSummaryProps): React.ReactElement | null {
  const { t } = useTranslation()
  if (matchCount === 0) return null

  const text = t('search.matchCount', {
    count: matchCount,
    pages: t('search.pageCount', { count: pageCount }),
  })

  return (
    <div
      data-testid="search-result-count-summary"
      className="text-xs text-muted-foreground px-3 py-1"
    >
      {text}
    </div>
  )
}
