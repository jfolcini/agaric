/**
 * Tests for HistoryFilterBar component.
 *
 * Validates:
 *  - Renders filter label and dropdown
 *  - Shows all op type options
 *  - Calls onFilterChange(null) when "All types" is selected
 *  - Calls onFilterChange with op type when a specific type is selected
 *  - a11y compliance
 *  - FEAT-3 Phase 8: "All spaces" Switch renders, toggles, composes with
 *    the op-type filter, and is a11y-clean.
 *  - UX-350: ? help icon opens a popover legend listing every op type
 *    with a one-line description.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { HistoryFilterBar } from '@/components/history/HistoryFilterBar'

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

// Mock Popover to avoid Radix portal / positioning issues in jsdom — matches
// the pattern used in SourcePageFilter.test.tsx and GraphFilterBar.test.tsx.
// With this mock the PopoverContent is always rendered, which is what we
// want for asserting the legend's descriptions.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-root">{children}</div>
  ),
  PopoverTrigger: ({
    children,
    asChild,
    ...props
  }: {
    children: React.ReactNode
    asChild?: boolean
    [key: string]: unknown
  }) => {
    if (asChild) return <>{children}</>
    return <button {...props}>{children}</button>
  },
  PopoverContent: ({
    children,
    ...props
  }: {
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <div data-testid="popover-content" {...props}>
      {children}
    </div>
  ),
}))

// Default props for the FEAT-3 Phase 8 "All spaces" toggle. Each test
// can override individual fields.
const baseProps = {
  showAllSpaces: false,
  onShowAllSpacesChange: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HistoryFilterBar', () => {
  // block-history-sheet-fix-2026-05-14: the standalone visible label was
  // dropped — the Select's `aria-label="Filter by operation type"` is the
  // accessible name, and the visible duplicate was stealing a vertical
  // row at narrow widths (the Sheet at ≈360 px). The combobox is still
  // queryable by its accessible name; that's the regression-resilient
  // contract.
  it('renders the filter dropdown queryable by accessible name', () => {
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />)

    expect(screen.getByRole('combobox', { name: /Filter by operation type/ })).toBeInTheDocument()
  })

  // block-history-sheet-fix-2026-05-14: the row container is now
  // `flex flex-wrap items-center gap-2` (was `flex flex-col sm:flex-row`).
  // The wrap-on-overflow model works for both the wide HistoryView and
  // the narrow ~512 px Sheet without a media query.
  it('row container uses `flex flex-wrap items-center` (compact, wraps when needed)', () => {
    const onFilterChange = vi.fn()
    const { container } = render(
      <HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />,
    )

    const row = container.querySelector('.history-filter-bar')
    expect(row).not.toBeNull()
    expect(row?.className).toContain('flex-wrap')
    expect(row?.className).toContain('items-center')
    expect(row?.className).not.toContain('flex-col')
    expect(row?.className).not.toContain('sm:flex-row')
  })

  // block-history-sheet-fix-2026-05-14: regression guard — at the
  // default render width, all expected controls are visible in one row
  // (the bar is `flex flex-wrap` so they only wrap when they actually
  // overflow). Enumerate via role queries since the controls are
  // queryable by accessible name even without a visible label.
  it('renders all filter controls as siblings in a single flex row', () => {
    const onFilterChange = vi.fn()
    const onShowAllSpacesChange = vi.fn()
    const { container } = render(
      <HistoryFilterBar
        opTypeFilter="edit_block"
        onFilterChange={onFilterChange}
        showAllSpaces={false}
        onShowAllSpacesChange={onShowAllSpacesChange}
      />,
    )

    const row = container.querySelector('.history-filter-bar')
    expect(row).not.toBeNull()

    // The Select trigger (rendered as a `combobox` by the global Radix
    // Select mock), the legend `?` button, the clear `✕` button, and the
    // "All spaces" switch should all be present.
    expect(screen.getByRole('combobox', { name: /Filter by operation type/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Op type legend' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /All spaces/i })).toBeInTheDocument()
  })

  it('shows all op type options', () => {
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />)

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    const options = select.querySelectorAll('option')

    // __all__ + 12 op types = 13 options
    expect(options).toHaveLength(13)
    expect(options[0]).toHaveTextContent('All types')
    expect(options[1]).toHaveTextContent('Edit')
    expect(options[2]).toHaveTextContent('Create')
    expect(options[3]).toHaveTextContent('Delete')
  })

  it('calls onFilterChange(null) when "All types" is selected', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    render(
      <HistoryFilterBar opTypeFilter="edit_block" onFilterChange={onFilterChange} {...baseProps} />,
    )

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, '__all__')

    expect(onFilterChange).toHaveBeenCalledWith(null)
  })

  it('calls onFilterChange with op type when a specific type is selected', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />)

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, 'edit_block')

    expect(onFilterChange).toHaveBeenCalledWith('edit_block')
  })

  it('reflects the current filter value in the select', () => {
    const onFilterChange = vi.fn()
    render(
      <HistoryFilterBar
        opTypeFilter="create_block"
        onFilterChange={onFilterChange}
        {...baseProps}
      />,
    )

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    expect(select).toHaveValue('create_block')
  })

  it('shows __all__ as selected value when opTypeFilter is null', () => {
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />)

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    expect(select).toHaveValue('__all__')
  })

  it('has no a11y violations', async () => {
    const onFilterChange = vi.fn()
    const { container } = render(
      <HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with a filter selected', async () => {
    const onFilterChange = vi.fn()
    const { container } = render(
      <HistoryFilterBar opTypeFilter="edit_block" onFilterChange={onFilterChange} {...baseProps} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── FEAT-3 Phase 8: "All spaces" toggle ────────────────────────────

  describe('"All spaces" toggle (FEAT-3 Phase 8)', () => {
    it('renders the Switch with its label', () => {
      const onFilterChange = vi.fn()
      const onShowAllSpacesChange = vi.fn()
      render(
        <HistoryFilterBar
          opTypeFilter={null}
          onFilterChange={onFilterChange}
          showAllSpaces={false}
          onShowAllSpacesChange={onShowAllSpacesChange}
        />,
      )

      // Radix Switch renders as a `role="switch"` button.
      const toggle = screen.getByRole('switch', { name: /All spaces/i })
      expect(toggle).toBeInTheDocument()
      // Off by default ⇒ unchecked.
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    })

    it('reflects the showAllSpaces prop in the Switch checked state', () => {
      const onFilterChange = vi.fn()
      const onShowAllSpacesChange = vi.fn()
      render(
        <HistoryFilterBar
          opTypeFilter={null}
          onFilterChange={onFilterChange}
          showAllSpaces={true}
          onShowAllSpacesChange={onShowAllSpacesChange}
        />,
      )

      const toggle = screen.getByRole('switch', { name: /All spaces/i })
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })

    it('calls onShowAllSpacesChange(true) when the user toggles it on', async () => {
      const user = userEvent.setup()
      const onFilterChange = vi.fn()
      const onShowAllSpacesChange = vi.fn()
      render(
        <HistoryFilterBar
          opTypeFilter={null}
          onFilterChange={onFilterChange}
          showAllSpaces={false}
          onShowAllSpacesChange={onShowAllSpacesChange}
        />,
      )

      const toggle = screen.getByRole('switch', { name: /All spaces/i })
      await user.click(toggle)
      expect(onShowAllSpacesChange).toHaveBeenCalledWith(true)
    })

    it('the op-type filter and the "All spaces" toggle compose independently', async () => {
      const user = userEvent.setup()
      const onFilterChange = vi.fn()
      const onShowAllSpacesChange = vi.fn()
      render(
        <HistoryFilterBar
          opTypeFilter={null}
          onFilterChange={onFilterChange}
          showAllSpaces={false}
          onShowAllSpacesChange={onShowAllSpacesChange}
        />,
      )

      // Flip the Switch ON.
      const toggle = screen.getByRole('switch', { name: /All spaces/i })
      await user.click(toggle)
      expect(onShowAllSpacesChange).toHaveBeenCalledWith(true)

      // Pick an op-type. The two callbacks are independent: changing the
      // op-type filter must not call onShowAllSpacesChange again.
      const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
      await user.selectOptions(select, 'edit_block')
      expect(onFilterChange).toHaveBeenCalledWith('edit_block')
      expect(onShowAllSpacesChange).toHaveBeenCalledTimes(1)
    })

    it('has no a11y violations with the toggle ON', async () => {
      const onFilterChange = vi.fn()
      const onShowAllSpacesChange = vi.fn()
      const { container } = render(
        <HistoryFilterBar
          opTypeFilter={null}
          onFilterChange={onFilterChange}
          showAllSpaces={true}
          onShowAllSpacesChange={onShowAllSpacesChange}
        />,
      )
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── UX-350: op-type legend popover ─────────────────────────────────

  describe('op-type legend popover (UX-350)', () => {
    it('renders the help button with the correct aria-label', () => {
      const onFilterChange = vi.fn()
      render(
        <HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />,
      )

      expect(screen.getByRole('button', { name: 'Op type legend' })).toBeInTheDocument()
    })

    it('clicking the help button does not throw and keeps the legend reachable', async () => {
      const user = userEvent.setup()
      const onFilterChange = vi.fn()
      render(
        <HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />,
      )

      const trigger = screen.getByRole('button', { name: 'Op type legend' })
      await user.click(trigger)

      // The Popover is mocked so its content is always rendered; what we
      // validate here is that clicking the trigger is wired up cleanly and
      // the legend container is present in the tree.
      expect(screen.getByTestId('popover-content')).toBeInTheDocument()
    })

    // PEND-23 M3: PopoverContent must carry an aria-label so screen readers
    // announce the popover purpose, not a generic "dialog".
    it('labels the popover with history.opTypeLegendPopoverLabel', () => {
      const onFilterChange = vi.fn()
      render(
        <HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />,
      )

      expect(screen.getByTestId('popover-content')).toHaveAttribute(
        'aria-label',
        'Operation type legend',
      )
    })

    it('the popover content includes op-type descriptions for every op type', () => {
      const onFilterChange = vi.fn()
      render(
        <HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />,
      )

      const content = screen.getByTestId('popover-content')

      // Title.
      expect(content).toHaveTextContent('What do these mean?')

      // Spot-check a handful of descriptions across the 12 op types — these
      // are the values supplied by the i18n keys
      // `history.opTypeDescription.<op_type>`.
      expect(content).toHaveTextContent('A new block was created')
      expect(content).toHaveTextContent('A block was soft-deleted (recoverable from Trash)')
      expect(content).toHaveTextContent('A block was permanently deleted')
      expect(content).toHaveTextContent('A soft-deleted block was restored')
      expect(content).toHaveTextContent('Block content was edited')

      // All 12 op types render as <dt>/<dd> rows inside the legend's <dl>.
      const rows = content.querySelectorAll('dl > div')
      expect(rows).toHaveLength(12)
    })
  })
})
