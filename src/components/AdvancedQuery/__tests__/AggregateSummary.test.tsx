/**
 * AggregateSummary — #4553 Phase 1 contributing-count tests.
 *
 * `avg`/`sum`/`min`/`max` fold over the NUMERIC subset of a target (non-
 * numeric rows are skipped by `numeric_coerce`), so the denominator/subset
 * size is invisible unless the chip shows it. This is surfaced by pairing a
 * fold-op chip with a sibling `Count` result over the SAME target, when the
 * caller requested one — never invented by the component itself.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { AggregateSummary } from '@/components/AdvancedQuery/AggregateSummary'
import type { AggregateResult, AggregateSpec } from '@/lib/tauri'

describe('AggregateSummary', () => {
  it('renders each result chip with no specs supplied (unchanged legacy behaviour)', () => {
    const results: AggregateResult[] = [{ op: 'count', value: null, count: 6 }]
    render(<AggregateSummary results={results} label="Aggregate summary" />)
    expect(screen.getByTestId('advanced-query-aggregate-chip')).toHaveTextContent('Count: 6')
  })

  it('renders a null fold result as an em-dash', () => {
    const results: AggregateResult[] = [{ op: 'sum', value: null, count: null }]
    render(<AggregateSummary results={results} label="Aggregate summary" />)
    expect(screen.getByTestId('advanced-query-aggregate-chip')).toHaveTextContent('Sum: —')
  })

  // #4553 Phase 1 — a sum + a sibling count-over-the-same-Property-target
  // shows the contributing numeric count beside the sum.
  it('shows the contributing count beside a sum over the same Property target', () => {
    const specs: AggregateSpec[] = [
      { op: 'sum', target: { type: 'Property', key: 'estimate' } },
      { op: 'count', target: { type: 'Property', key: 'estimate' } },
    ]
    const results: AggregateResult[] = [
      { op: 'sum', value: 16, count: null },
      { op: 'count', value: null, count: 3 },
    ]
    render(<AggregateSummary results={results} specs={specs} label="Aggregate summary" />)
    const chips = screen.getAllByTestId('advanced-query-aggregate-chip')
    expect(chips[0]).toHaveTextContent('Sum: 16 (n=3)')
    // The Count chip itself is unaffected (it is the source, not a fold).
    expect(chips[1]).toHaveTextContent('Count: 3')
    expect(chips[1]).not.toHaveTextContent('(n=')
  })

  it('does NOT show a contributing count when no sibling Count-over-the-same-target was requested', () => {
    const specs: AggregateSpec[] = [{ op: 'sum', target: { type: 'Property', key: 'estimate' } }]
    const results: AggregateResult[] = [{ op: 'sum', value: 16, count: null }]
    render(<AggregateSummary results={results} specs={specs} label="Aggregate summary" />)
    expect(screen.getByTestId('advanced-query-aggregate-chip')).toHaveTextContent('Sum: 16')
    expect(screen.getByTestId('advanced-query-aggregate-chip')).not.toHaveTextContent('(n=')
  })

  it('does NOT pair a fold over a DIFFERENT target with an unrelated Count', () => {
    const specs: AggregateSpec[] = [
      { op: 'sum', target: { type: 'Property', key: 'estimate' } },
      { op: 'count', target: { type: 'Property', key: 'other' } },
    ]
    const results: AggregateResult[] = [
      { op: 'sum', value: 16, count: null },
      { op: 'count', value: null, count: 9 },
    ]
    render(<AggregateSummary results={results} specs={specs} label="Aggregate summary" />)
    const chips = screen.getAllByTestId('advanced-query-aggregate-chip')
    expect(chips[0]).toHaveTextContent('Sum: 16')
    expect(chips[0]).not.toHaveTextContent('(n=')
  })

  it('does NOT pair a Column-target sum with a Property-target Count', () => {
    const specs: AggregateSpec[] = [
      { op: 'sum', target: { type: 'Column', name: 'priority' } },
      { op: 'count', target: { type: 'Property', key: 'estimate' } },
    ]
    const results: AggregateResult[] = [
      { op: 'sum', value: 4, count: null },
      { op: 'count', value: null, count: 3 },
    ]
    render(<AggregateSummary results={results} specs={specs} label="Aggregate summary" />)
    const chips = screen.getAllByTestId('advanced-query-aggregate-chip')
    expect(chips[0]).toHaveTextContent('Sum: 4')
    expect(chips[0]).not.toHaveTextContent('(n=')
  })

  it('has no a11y violations with a contributing-count chip', async () => {
    const specs: AggregateSpec[] = [
      { op: 'avg', target: { type: 'Property', key: 'estimate' } },
      { op: 'count', target: { type: 'Property', key: 'estimate' } },
    ]
    const results: AggregateResult[] = [
      { op: 'avg', value: 5.33, count: null },
      { op: 'count', value: null, count: 3 },
    ]
    const { container } = render(
      <AggregateSummary results={results} specs={specs} label="Aggregate summary" />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
