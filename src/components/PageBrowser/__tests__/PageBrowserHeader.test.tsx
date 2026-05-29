/**
 * Tests for `PageBrowserHeader` (PEND-56 Phase 2 extension).
 *
 * Coverage:
 *   1. Density change handler fires with the chosen `DensityMode` value.
 *   2. All 7 `SortOption` items are reachable via the sort select.
 *   3. `axe(container)` reports no a11y violations.
 *
 * Radix Select is globally mocked to a native `<select>` tree in
 * `src/test-setup.ts`, so `userEvent.selectOptions` drives both
 * selects directly. The trigger's `aria-label` is forwarded onto
 * the native `<select>` by the mock, which gives us a stable handle
 * by accessible name.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import { PageBrowserHeader, type PageBrowserHeaderProps } from '../PageBrowserHeader'

function makeProps(overrides: Partial<PageBrowserHeaderProps> = {}): PageBrowserHeaderProps {
  return {
    formRef: createRef<HTMLFormElement>(),
    newPageInputRef: createRef<HTMLInputElement>(),
    newPageName: '',
    onNewPageNameChange: vi.fn(),
    isCreating: false,
    onSubmit: vi.fn(),
    showSearchAndSort: true,
    filterText: '',
    onFilterTextChange: vi.fn(),
    sortOption: 'alphabetical',
    onSortChange: vi.fn(),
    density: 'regular',
    onDensityChange: vi.fn(),
    ...overrides,
  }
}

describe('PageBrowserHeader (PEND-56)', () => {
  it('fires onDensityChange with the chosen DensityMode', async () => {
    const onDensityChange = vi.fn()
    render(<PageBrowserHeader {...makeProps({ onDensityChange })} />)

    const densitySelect = screen.getByRole('combobox', {
      name: t('pageBrowser.densityLabel'),
    })
    await userEvent.selectOptions(densitySelect, 'compact')

    expect(onDensityChange).toHaveBeenCalledTimes(1)
    expect(onDensityChange).toHaveBeenCalledWith('compact')
  })

  it('exposes all 7 sort modes in the sort select', () => {
    render(<PageBrowserHeader {...makeProps()} />)

    const sortSelect = screen.getByRole('combobox', {
      name: t('pageBrowser.sortLabel'),
    })
    // The mocked Select renders <option>s as direct children; the test
    // pulls the option values to verify the union is fully surfaced and
    // ordered as the spec requires (3 legacy then 4 new).
    const options = Array.from(sortSelect.querySelectorAll('option')).map((opt) => opt.value)
    expect(options).toEqual([
      'alphabetical',
      'recent',
      'created',
      'recently-modified',
      'most-linked',
      'most-content',
      'default',
    ])
  })

  it('fires onSortChange when a new sort mode is selected', async () => {
    const onSortChange = vi.fn()
    render(<PageBrowserHeader {...makeProps({ onSortChange })} />)

    const sortSelect = screen.getByRole('combobox', {
      name: t('pageBrowser.sortLabel'),
    })
    await userEvent.selectOptions(sortSelect, 'most-linked')

    expect(onSortChange).toHaveBeenCalledWith('most-linked')
  })

  it('exposes all 3 density modes in the density select', () => {
    render(<PageBrowserHeader {...makeProps()} />)

    const densitySelect = screen.getByRole('combobox', {
      name: t('pageBrowser.densityLabel'),
    })
    const options = Array.from(densitySelect.querySelectorAll('option')).map((opt) => opt.value)
    expect(options).toEqual(['compact', 'regular', 'expanded'])
  })

  it('has no axe violations', async () => {
    const { container } = render(<PageBrowserHeader {...makeProps()} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── PEND-58d D3 — frontend-only-sort-at-scale cue ───────────────────

  it('renders the frontend-sort cue when frontendSortAtScale is true', () => {
    render(<PageBrowserHeader {...makeProps({ frontendSortAtScale: true })} />)
    const cue = screen.getByTestId('page-browser-frontend-sort-cue')
    expect(cue).toBeInTheDocument()
    expect(cue).toHaveTextContent(t('pageBrowser.frontendSortHint'))
  })

  it('does not render the frontend-sort cue when frontendSortAtScale is false', () => {
    render(<PageBrowserHeader {...makeProps({ frontendSortAtScale: false })} />)
    expect(screen.queryByTestId('page-browser-frontend-sort-cue')).not.toBeInTheDocument()
  })

  it('does not render the frontend-sort cue when frontendSortAtScale is omitted', () => {
    render(<PageBrowserHeader {...makeProps()} />)
    expect(screen.queryByTestId('page-browser-frontend-sort-cue')).not.toBeInTheDocument()
  })

  it('has no axe violations with the frontend-sort cue present', async () => {
    const { container } = render(
      <PageBrowserHeader {...makeProps({ frontendSortAtScale: true })} />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── PEND-58d D11 / T-F1 — count-label branches ──────────────────────
  //
  // The chip pairs a numerator and denominator that must share a basis:
  //  (a) no chips, no text → `countAll`     ("312 pages")
  //  (b) free-text query   → `countFiltered`("23 of 312 matching")
  //  (c) chips, no text    → `countMatching`("312 matching pages")
  //  (·) null total        → no chip at all
  describe('count-label branches (T-F1)', () => {
    it('renders no count chip when totalCount is undefined', () => {
      render(<PageBrowserHeader {...makeProps({ totalCount: undefined })} />)
      expect(screen.queryByTestId('page-browser-count')).not.toBeInTheDocument()
    })

    it('renders the countAll form when no text and no chip filters are active', () => {
      render(
        <PageBrowserHeader
          {...makeProps({
            totalCount: 312,
            hasTextQuery: false,
            hasChipFilters: false,
          })}
        />,
      )
      const chip = screen.getByTestId('page-browser-count')
      expect(chip).toHaveTextContent(t('pageBrowser.countAll', { count: 312 }))
    })

    it('renders the countFiltered form when a free-text query is active', () => {
      render(
        <PageBrowserHeader
          {...makeProps({
            totalCount: 312,
            filteredCount: 23,
            hasTextQuery: true,
            hasChipFilters: false,
          })}
        />,
      )
      const chip = screen.getByTestId('page-browser-count')
      expect(chip).toHaveTextContent(t('pageBrowser.countFiltered', { loaded: 23, total: 312 }))
    })

    it('renders the countMatching form when chips are active without a text query', () => {
      render(
        <PageBrowserHeader
          {...makeProps({
            totalCount: 312,
            filteredCount: 312,
            hasTextQuery: false,
            hasChipFilters: true,
          })}
        />,
      )
      const chip = screen.getByTestId('page-browser-count')
      expect(chip).toHaveTextContent(t('pageBrowser.countMatching', { count: 312 }))
    })

    it('text query takes precedence over chips (countFiltered, not countMatching)', () => {
      // Both axes active: the free-text box is the inner narrowing, so the
      // chip shows "X of Y matching" (the loaded-narrowed numerator) rather
      // than the chip-only single-number form.
      render(
        <PageBrowserHeader
          {...makeProps({
            totalCount: 312,
            filteredCount: 5,
            hasTextQuery: true,
            hasChipFilters: true,
          })}
        />,
      )
      const chip = screen.getByTestId('page-browser-count')
      expect(chip).toHaveTextContent(t('pageBrowser.countFiltered', { loaded: 5, total: 312 }))
      expect(chip).not.toHaveTextContent(t('pageBrowser.countMatching', { count: 312 }))
    })
  })

  // ── PEND-58d D13 — header row wraps on narrow viewports ──────────────
  it('the search/sort/density row carries flex-wrap so it can wrap on mobile', () => {
    const { container } = render(<PageBrowserHeader {...makeProps()} />)
    // The controls row is the second child of `.page-browser-header` (the
    // create form is first). It must opt into wrapping rather than
    // overflowing horizontally on a narrow viewport.
    const controlsRow = container.querySelector('.page-browser-header > div.flex-wrap')
    expect(controlsRow).not.toBeNull()
    expect(controlsRow).toHaveClass('flex-wrap')
  })
})
