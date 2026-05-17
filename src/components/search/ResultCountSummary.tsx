/**
 * ResultCountSummary — "N matches in M pages" header above the first
 * search-result group (PEND-50 Phase 1).
 *
 * Empty result counts render nothing — the SearchPanel surfaces
 * `search.noResultsFound` elsewhere when `searched && !loading &&
 * results.length === 0`. The singular form (`1 match in 1 page`) is
 * surfaced via a dedicated i18n key rather than `i18next` plural rules
 * because we have two independent quantities (matches, pages); a single
 * `_one` / `_other` form would only pluralise the first.
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

  const isSingular = matchCount === 1 && pageCount === 1
  const text = isSingular
    ? t('search.matchCountSingular')
    : t('search.matchCountPlural', { matchCount, pageCount })

  return (
    <div
      data-testid="search-result-count-summary"
      className="text-xs text-muted-foreground px-3 py-1"
    >
      {text}
    </div>
  )
}
