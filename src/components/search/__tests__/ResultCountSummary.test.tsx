/**
 * Tests for `ResultCountSummary` — the "N matches in M pages" string
 * Above the first search-result group (Phase 1).
 *
 * 0 matches renders nothing (SearchPanel handles empty elsewhere via
 * `search.noResultsFound`); otherwise matches and pages each take their own
 * singular or plural noun.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ResultCountSummary } from '@/components/search/ResultCountSummary'

describe('ResultCountSummary', () => {
  it('renders nothing for 0 matches', () => {
    const { container } = render(<ResultCountSummary matchCount={0} pageCount={0} />)
    expect(container.firstChild).toBeNull()
  })

  it.each([
    [1, 1, '1 match in 1 page'],
    [9, 3, '9 matches in 3 pages'],
    [50, 1, '50 matches in 1 page'],
    [1, 2, '1 match in 2 pages'],
  ])('renders %i match(es) over %i page(s) as "%s"', (matchCount, pageCount, text) => {
    render(<ResultCountSummary matchCount={matchCount} pageCount={pageCount} />)
    expect(screen.getByTestId('search-result-count-summary').textContent).toBe(text)
  })

  it('exposes a stable `data-testid` for integration tests', () => {
    render(<ResultCountSummary matchCount={3} pageCount={2} />)
    expect(screen.getByTestId('search-result-count-summary')).toBeInTheDocument()
  })
})
