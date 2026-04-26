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
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { HistoryFilterBar } from '../HistoryFilterBar'

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

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
  it('renders filter label and dropdown', () => {
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} {...baseProps} />)

    expect(screen.getByText('Filter:')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /Filter by operation type/ })).toBeInTheDocument()
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
})
