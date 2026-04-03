/**
 * Tests for AgendaFilterBuilder component.
 *
 * Validates:
 *  1. Renders empty state with "+ Add filter" button
 *  2. Shows filter chip when filter is provided
 *  3. Chip shows dimension label and values
 *  4. X button removes filter
 *  5. "Filters combined with AND" label appears with 2+ filters
 *  6. Add filter dropdown shows all dimension options
 *  7. Selecting Status dimension shows TODO/DOING/DONE checkboxes
 *  8. A11y audit passes
 *  9. Selecting Priority dimension shows 1/2/3 checkboxes
 * 10. Tag dimension shows text input
 * 11. Already-used dimensions are disabled in the picker
 * 12. Apply button is disabled until values are selected
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { AgendaFilter, AgendaFilterBuilderProps } from '../AgendaFilterBuilder'
import { AgendaFilterBuilder } from '../AgendaFilterBuilder'

const defaultProps: AgendaFilterBuilderProps = {
  filters: [],
  onFiltersChange: vi.fn(),
}

function renderBuilder(overrides?: Partial<AgendaFilterBuilderProps>) {
  const props = { ...defaultProps, ...overrides }
  return render(<AgendaFilterBuilder {...props} />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AgendaFilterBuilder', () => {
  // -----------------------------------------------------------------------
  // 1. Empty state
  // -----------------------------------------------------------------------
  it('renders empty state with "+ Add filter" button', () => {
    renderBuilder()
    expect(screen.getByRole('button', { name: /Add filter/i })).toBeInTheDocument()
    // No chips should be visible
    expect(screen.queryByLabelText(/Applied filters/)).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 2. Shows filter chip when filter is provided
  // -----------------------------------------------------------------------
  it('shows filter chip when filter is provided', () => {
    const filters: AgendaFilter[] = [{ dimension: 'status', values: ['TODO'] }]
    renderBuilder({ filters })

    const list = screen.getByLabelText('Applied filters')
    expect(list).toBeInTheDocument()
    expect(within(list).getByText('Status:')).toBeInTheDocument()
    expect(within(list).getByText('TODO')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 3. Chip shows dimension label and values (multiple values)
  // -----------------------------------------------------------------------
  it('chip displays dimension label and comma-separated values', () => {
    const filters: AgendaFilter[] = [{ dimension: 'status', values: ['TODO', 'DOING'] }]
    renderBuilder({ filters })

    expect(screen.getByText('Status:')).toBeInTheDocument()
    expect(screen.getByText('TODO, DOING')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 4. X button removes filter
  // -----------------------------------------------------------------------
  it('removes filter when X button is clicked', async () => {
    const user = userEvent.setup()
    const onFiltersChange = vi.fn()
    const filters: AgendaFilter[] = [
      { dimension: 'status', values: ['TODO'] },
      { dimension: 'priority', values: ['1'] },
    ]
    renderBuilder({ filters, onFiltersChange })

    // Click the X on the Status chip
    await user.click(screen.getByLabelText('Remove Status filter'))

    expect(onFiltersChange).toHaveBeenCalledWith([{ dimension: 'priority', values: ['1'] }])
  })

  // -----------------------------------------------------------------------
  // 5. "Filters combined with AND" label with 2+ filters
  // -----------------------------------------------------------------------
  it('shows "Filters combined with AND" label when 2+ filters active', () => {
    const filters: AgendaFilter[] = [
      { dimension: 'status', values: ['TODO'] },
      { dimension: 'priority', values: ['1'] },
    ]
    renderBuilder({ filters })

    expect(screen.getByText('Filters combined with AND')).toBeInTheDocument()
  })

  it('does not show "Filters combined with AND" with only 1 filter', () => {
    const filters: AgendaFilter[] = [{ dimension: 'status', values: ['TODO'] }]
    renderBuilder({ filters })

    expect(screen.queryByText('Filters combined with AND')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 6. Add filter dropdown shows all dimension options
  // -----------------------------------------------------------------------
  it('add filter popover shows all dimension options', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))

    const list = screen.getByRole('list', { name: /Filter dimensions/i })
    expect(within(list).getByText('Status')).toBeInTheDocument()
    expect(within(list).getByText('Priority')).toBeInTheDocument()
    expect(within(list).getByText('Due date')).toBeInTheDocument()
    expect(within(list).getByText('Tag')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 7. Selecting Status dimension shows TODO/DOING/DONE checkboxes
  // -----------------------------------------------------------------------
  it('selecting Status dimension shows TODO/DOING/DONE checkboxes', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Status'))

    const group = screen.getByRole('group', { name: /Status options/i })
    expect(within(group).getByLabelText('TODO')).toBeInTheDocument()
    expect(within(group).getByLabelText('DOING')).toBeInTheDocument()
    expect(within(group).getByLabelText('DONE')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 8. A11y audit passes
  // -----------------------------------------------------------------------
  it('has no a11y violations with no filters', async () => {
    const { container } = renderBuilder()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with active filters', async () => {
    const { container } = renderBuilder({
      filters: [
        { dimension: 'status', values: ['TODO', 'DOING'] },
        { dimension: 'priority', values: ['1'] },
      ],
    })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // -----------------------------------------------------------------------
  // 9. Selecting Priority dimension shows 1/2/3 checkboxes
  // -----------------------------------------------------------------------
  it('selecting Priority dimension shows 1/2/3 checkboxes', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Priority'))

    const group = screen.getByRole('group', { name: /Priority options/i })
    expect(within(group).getByLabelText('1')).toBeInTheDocument()
    expect(within(group).getByLabelText('2')).toBeInTheDocument()
    expect(within(group).getByLabelText('3')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 10. Tag dimension shows text input
  // -----------------------------------------------------------------------
  it('selecting Tag dimension shows a text input', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Tag'))

    expect(screen.getByLabelText('Tag name')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 11. Already-used dimensions are disabled
  // -----------------------------------------------------------------------
  it('disables already-used dimensions in the add filter picker', async () => {
    const user = userEvent.setup()
    const filters: AgendaFilter[] = [{ dimension: 'status', values: ['TODO'] }]
    renderBuilder({ filters })

    await user.click(screen.getByRole('button', { name: /Add filter/i }))

    const statusBtn = screen.getByText('Status').closest('button')
    expect(statusBtn).toBeDisabled()

    const priorityBtn = screen.getByText('Priority').closest('button')
    expect(priorityBtn).not.toBeDisabled()
  })

  // -----------------------------------------------------------------------
  // 12. Full add-filter flow (select dimension + check values + apply)
  // -----------------------------------------------------------------------
  it('adds a filter via the full popover flow', async () => {
    const user = userEvent.setup()
    const onFiltersChange = vi.fn()
    renderBuilder({ onFiltersChange })

    // Open the add filter popover
    await user.click(screen.getByRole('button', { name: /Add filter/i }))

    // Pick the Status dimension
    await user.click(screen.getByText('Status'))

    // Check TODO and DOING
    await user.click(screen.getByLabelText('TODO'))
    await user.click(screen.getByLabelText('DOING'))

    // Apply
    await user.click(screen.getByRole('button', { name: /Apply filter/i }))

    expect(onFiltersChange).toHaveBeenCalledWith([
      { dimension: 'status', values: ['TODO', 'DOING'] },
    ])
  })

  // -----------------------------------------------------------------------
  // 13. Apply button is disabled until values are selected
  // -----------------------------------------------------------------------
  it('apply button is disabled until at least one value is selected', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Status'))

    const applyBtn = screen.getByRole('button', { name: /Apply filter/i })
    expect(applyBtn).toBeDisabled()

    // Check a value
    await user.click(screen.getByLabelText('TODO'))
    expect(applyBtn).not.toBeDisabled()
  })

  // -----------------------------------------------------------------------
  // 14. Fieldset has proper sr-only legend
  // -----------------------------------------------------------------------
  it('renders sr-only legend inside fieldset', () => {
    const { container } = renderBuilder()
    const legend = container.querySelector('fieldset legend')
    expect(legend).toBeInTheDocument()
    expect(legend).toHaveTextContent('Agenda filters')
    expect(legend).toHaveClass('sr-only')
  })

  // -----------------------------------------------------------------------
  // 15. Does not render applied filters list when no filters active
  // -----------------------------------------------------------------------
  it('does not render applied filters list when no filters active', () => {
    const { container } = renderBuilder()
    expect(container.querySelector('ul[aria-label="Applied filters"]')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 16. dueDate dimension shows all 6 choices including new presets
  // -----------------------------------------------------------------------
  it('dueDate dimension shows all 6 choices including new presets', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Due date'))

    const group = screen.getByRole('group', { name: /Due date options/i })
    expect(within(group).getByLabelText('Today')).toBeInTheDocument()
    expect(within(group).getByLabelText('This week')).toBeInTheDocument()
    expect(within(group).getByLabelText('Overdue')).toBeInTheDocument()
    expect(within(group).getByLabelText('Next 7 days')).toBeInTheDocument()
    expect(within(group).getByLabelText('Next 14 days')).toBeInTheDocument()
    expect(within(group).getByLabelText('Next 30 days')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 17. scheduledDate dimension shows same 6 choices as dueDate
  // -----------------------------------------------------------------------
  it('scheduledDate dimension shows same 6 choices as dueDate', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Scheduled date'))

    const group = screen.getByRole('group', { name: /Scheduled date options/i })
    expect(within(group).getByLabelText('Today')).toBeInTheDocument()
    expect(within(group).getByLabelText('This week')).toBeInTheDocument()
    expect(within(group).getByLabelText('Overdue')).toBeInTheDocument()
    expect(within(group).getByLabelText('Next 7 days')).toBeInTheDocument()
    expect(within(group).getByLabelText('Next 14 days')).toBeInTheDocument()
    expect(within(group).getByLabelText('Next 30 days')).toBeInTheDocument()
  })
})
