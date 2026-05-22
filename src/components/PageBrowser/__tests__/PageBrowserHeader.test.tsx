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
})
