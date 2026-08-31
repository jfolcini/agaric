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
import type { AggregateResult, AggregateSpec, AggregateTarget } from '@/lib/bindings'

/** Format one aggregate result's numeric value as a display string. */
function formatAggregateValue(result: AggregateResult): string {
  if (result.op === 'count') {
    return String(result.count ?? 0)
  }
  if (result.value == null) return '—'
  // Trim a trailing `.0` style on integers; keep up to 2 dp otherwise.
  return Number.isInteger(result.value) ? String(result.value) : result.value.toFixed(2)
}

/** Structural equality for `AggregateTarget` — `Column` compares `name`, `Property` compares `key`. */
function targetsEqual(
  a: AggregateTarget | null | undefined,
  b: AggregateTarget | null | undefined,
): boolean {
  if (a == null || b == null) return false
  if (a.type !== b.type) return false
  if (a.type === 'Column' && b.type === 'Column') return a.name === b.name
  if (a.type === 'Property' && b.type === 'Property') return a.key === b.key
  return false
}

/**
 * #4553 Phase 1 — "show the contributing count beside each average" (`avg`
 * divides by the NUMERIC count, not the row count, so the denominator would
 * otherwise be invisible; the same applies to `sum`/`min`/`max` skipping
 * non-numeric rows). Rather than inventing a second backend round trip, this
 * reads a sibling `Count` result the caller ALREADY requested over the same
 * target within the same `AdvancedQueryRequest.aggregates` — `AggregateResult`
 * carries no `target` of its own (results are positional, matched back to the
 * request by index), so `specs` (the request, same order as `results`) is
 * required to find it. Returns `null` — render nothing extra — when `specs`
 * wasn't supplied, the result is `count` itself, has no target, or no sibling
 * `Count` over that same target was requested.
 */
function contributingCount(
  specs: ReadonlyArray<AggregateSpec> | undefined,
  results: ReadonlyArray<AggregateResult>,
  index: number,
): number | null {
  if (!specs || specs.length !== results.length) return null
  const spec = specs[index]
  if (!spec || spec.op === 'count' || spec.target == null) return null
  const siblingIndex = specs.findIndex(
    (s, i) => i !== index && s.op === 'count' && targetsEqual(s.target, spec.target),
  )
  if (siblingIndex === -1) return null
  return results[siblingIndex]?.count ?? null
}

export interface AggregateSummaryProps {
  /** The computed aggregate results, in request order. */
  results: AggregateResult[]
  /**
   * The request specs that produced `results`, in the SAME order (#4553
   * Phase 1). Optional — omit it (as the per-group chips in `GroupedResults`
   * still do) to render exactly as before, with no contributing-count
   * suffix. When supplied and its length matches `results`, a fold-op chip
   * (`sum`/`avg`/`min`/`max`) whose target has a sibling `Count` request
   * over the same target renders that count alongside its value.
   */
  specs?: AggregateSpec[]
  /** Accessible label for the summary container. */
  label: string
  /** Test id forwarded to the container (defaults to `advanced-query-aggregate-summary`). */
  testId?: string
}

export function AggregateSummary({
  results,
  specs,
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
      {results.map((result, index) => {
        const n = contributingCount(specs, results, index)
        return (
          <Badge
            key={`${result.op}:${result.value ?? ''}:${result.count ?? ''}`}
            tone="default"
            size="sm"
            data-testid="advanced-query-aggregate-chip"
          >
            {t(`advancedQuery.aggregate.op.${result.op}`)}: {formatAggregateValue(result)}
            {n != null && ` ${t('advancedQuery.aggregate.contributingCount', { n })}`}
          </Badge>
        )
      })}
    </div>
  )
}
