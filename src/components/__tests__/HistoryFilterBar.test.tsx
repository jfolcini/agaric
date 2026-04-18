/**
 * Tests for HistoryFilterBar component.
 *
 * Validates:
 *  - Renders filter label and dropdown
 *  - Shows all op type options
 *  - Calls onFilterChange(null) when "All types" is selected
 *  - Calls onFilterChange with op type when a specific type is selected
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { HistoryFilterBar } from '../HistoryFilterBar'

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HistoryFilterBar', () => {
  it('renders filter label and dropdown', () => {
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} />)

    expect(screen.getByText('Filter:')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /Filter by operation type/ })).toBeInTheDocument()
  })

  it('shows all op type options', () => {
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} />)

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
    render(<HistoryFilterBar opTypeFilter="edit_block" onFilterChange={onFilterChange} />)

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, '__all__')

    expect(onFilterChange).toHaveBeenCalledWith(null)
  })

  it('calls onFilterChange with op type when a specific type is selected', async () => {
    const user = userEvent.setup()
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} />)

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    await user.selectOptions(select, 'edit_block')

    expect(onFilterChange).toHaveBeenCalledWith('edit_block')
  })

  it('reflects the current filter value in the select', () => {
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter="create_block" onFilterChange={onFilterChange} />)

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    expect(select).toHaveValue('create_block')
  })

  it('shows __all__ as selected value when opTypeFilter is null', () => {
    const onFilterChange = vi.fn()
    render(<HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} />)

    const select = screen.getByRole('combobox', { name: /Filter by operation type/ })
    expect(select).toHaveValue('__all__')
  })

  it('has no a11y violations', async () => {
    const onFilterChange = vi.fn()
    const { container } = render(
      <HistoryFilterBar opTypeFilter={null} onFilterChange={onFilterChange} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with a filter selected', async () => {
    const onFilterChange = vi.fn()
    const { container } = render(
      <HistoryFilterBar opTypeFilter="edit_block" onFilterChange={onFilterChange} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
