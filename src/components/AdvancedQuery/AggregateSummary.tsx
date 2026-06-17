/**
 * AggregateSummary — renders a row of aggregate-result chips (#1280 D2).
 *
 * Used both for the FLAT-mode global summary bar and for the per-group chips in
 * grouped mode. Each chip pairs the requested operator label with its computed
 * value: `count` reads `count`, the fold operators (`sum`/`avg`/`min`/`max`)
 * read `value`. A `null` fold result (empty / all-non-numeric set) renders as an
 * em-dash so the chip is never blank.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import type { AggregateResult } from '@/lib/tauri'

/** Format one aggregate result's numeric value as a display string. */
function formatAggregateValue(result: AggregateResult): string {
  if (result.op === 'count') {
    return String(result.count ?? 0)
  }
  if (result.value == null) return '—'
  // Trim a trailing `.0` style on integers; keep up to 2 dp otherwise.
  return Number.isInteger(result.value) ? String(result.value) : result.value.toFixed(2)
}

export interface AggregateSummaryProps {
  /** The computed aggregate results, in request order. */
  results: AggregateResult[]
  /** Accessible label for the summary container. */
  label: string
  /** Test id forwarded to the container (defaults to `advanced-query-aggregate-summary`). */
  testId?: string
}

export function AggregateSummary({
  results,
  label,
  testId = 'advanced-query-aggregate-summary',
}: AggregateSummaryProps): React.ReactElement | null {
  const { t } = useTranslation()
  if (results.length === 0) return null
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a labelled grouping of read-only aggregate chips; <fieldset> would imply form controls
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      {results.map((result, index) => (
        <Badge
          // biome-ignore lint/suspicious/noArrayIndexKey: aggregate results are an ordered list keyed by request order
          key={index}
          tone="default"
          size="sm"
          data-testid="advanced-query-aggregate-chip"
        >
          {t(`advancedQuery.aggregate.op.${result.op}`)}: {formatAggregateValue(result)}
        </Badge>
      ))}
    </div>
  )
}
