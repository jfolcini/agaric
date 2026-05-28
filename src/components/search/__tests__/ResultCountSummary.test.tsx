/**
 * Tests for `ResultCountSummary` — the "N matches in M pages" string
 * above the first search-result group (PEND-50 Phase 1).
 *
 * Covers the three string variants enumerated in the plan:
 *  - 0 matches / 0 pages → renders nothing (SearchPanel handles empty
 *    elsewhere via `search.noResultsFound`).
 *  - 1 match in 1 page → singular form.
 *  - N matches in M pages → plural form with both counts.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { t } from '@/lib/i18n'

import { ResultCountSummary } from '../ResultCountSummary'

describe('ResultCountSummary', () => {
  it('renders nothing for 0 matches', () => {
    const { container } = render(<ResultCountSummary matchCount={0} pageCount={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the singular form for 1 match in 1 page', () => {
    render(<ResultCountSummary matchCount={1} pageCount={1} />)
    expect(screen.getByText(t('search.matchCountSingular'))).toBeInTheDocument()
  })

  it('renders the plural form for N matches in M pages', () => {
    render(<ResultCountSummary matchCount={9} pageCount={3} />)
    expect(
      screen.getByText(t('search.matchCountPlural', { matchCount: 9, pageCount: 3 })),
    ).toBeInTheDocument()
  })

  it('renders the plural form for 2-and-1 (still plural because of the second quantity)', () => {
    render(<ResultCountSummary matchCount={2} pageCount={1} />)
    expect(
      screen.getByText(t('search.matchCountPlural', { matchCount: 2, pageCount: 1 })),
    ).toBeInTheDocument()
  })

  it('exposes a stable `data-testid` for integration tests', () => {
    render(<ResultCountSummary matchCount={3} pageCount={2} />)
    expect(screen.getByTestId('search-result-count-summary')).toBeInTheDocument()
  })
})
