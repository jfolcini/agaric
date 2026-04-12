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
 * 10. Tag dimension shows searchable tag autocomplete
 * 11. Already-used dimensions are disabled in the picker
 * 12. Apply button is disabled until values are selected
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('@/components/ui/select', () => {
  const React = require('react')
  const Ctx = React.createContext({})

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children?: React.ReactNode
  }) {
    const triggerPropsRef = React.useRef({})
    return React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange, triggerPropsRef } },
      children,
    )
  }

  function SelectTrigger({ size, className, ...props }: Record<string, unknown>) {
    const ctx = React.useContext(Ctx)
    Object.assign(ctx.triggerPropsRef.current, { size, className, ...props })
    return null
  }

  function SelectValue() {
    return null
  }

  function SelectContent({ children }: { children?: React.ReactNode }) {
    const ctx = React.useContext(Ctx)
    const tp = ctx.triggerPropsRef.current
    return React.createElement(
      'select',
      {
        value: ctx.value ?? '',
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => ctx.onValueChange?.(e.target.value),
        'aria-label': tp['aria-label'],
        id: tp.id,
      },
      children,
    )
  }

  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    return React.createElement('option', { value }, children)
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

import type {
  AgendaFilter,
  AgendaFilterBuilderProps,
  AgendaSortGroupControlsProps,
} from '../AgendaFilterBuilder'
import { AgendaFilterBuilder, AgendaSortGroupControls, getTaskStates } from '../AgendaFilterBuilder'

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
    expect(within(list).getByText('Created date')).toBeInTheDocument()
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
  // 10. Tag dimension shows searchable tag autocomplete
  // -----------------------------------------------------------------------
  it('selecting Tag dimension shows a searchable tag autocomplete', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Tag'))

    expect(screen.getByLabelText('Tag name')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('adds a tag filter via search and selection', async () => {
    const mockedInvoke = vi.mocked(invoke)
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_tags_by_prefix') {
        const a = args as Record<string, unknown>
        const prefix = ((a['prefix'] as string) ?? '').toLowerCase()
        return [
          { tag_id: 'TAG_1', name: 'work', usage_count: 5 },
          { tag_id: 'TAG_2', name: 'workout', usage_count: 2 },
        ].filter((t) => t.name.toLowerCase().startsWith(prefix))
      }
      return []
    })

    const user = userEvent.setup()
    const onFiltersChange = vi.fn()
    renderBuilder({ onFiltersChange })

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Tag'))

    await user.type(screen.getByRole('combobox'), 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    await user.click(options[0] as HTMLElement)

    await user.click(screen.getByRole('button', { name: /Apply filter/i }))

    expect(onFiltersChange).toHaveBeenCalledWith([{ dimension: 'tag', values: ['work'] }])
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

  // -----------------------------------------------------------------------
  // 18. completedDate dimension appears in picker and shows past-oriented choices
  // -----------------------------------------------------------------------
  it('completedDate dimension appears in the add filter picker', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))

    const list = screen.getByRole('list', { name: /Filter dimensions/i })
    expect(within(list).getByText('Completed date')).toBeInTheDocument()
  })

  it('completedDate dimension shows past-oriented choices', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Completed date'))

    const group = screen.getByRole('group', { name: /Completed date options/i })
    expect(within(group).getByLabelText('Today')).toBeInTheDocument()
    expect(within(group).getByLabelText('This week')).toBeInTheDocument()
    expect(within(group).getByLabelText('Last 7 days')).toBeInTheDocument()
    expect(within(group).getByLabelText('Last 30 days')).toBeInTheDocument()
  })

  it('completedDate does not show Overdue or Next N days choices', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Completed date'))

    const group = screen.getByRole('group', { name: /Completed date options/i })
    expect(within(group).queryByLabelText('Overdue')).not.toBeInTheDocument()
    expect(within(group).queryByLabelText('Next 7 days')).not.toBeInTheDocument()
    expect(within(group).queryByLabelText('Next 14 days')).not.toBeInTheDocument()
    expect(within(group).queryByLabelText('Next 30 days')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Created date dimension shows last-N presets (#642)
  // -----------------------------------------------------------------------
  it('selecting Created date dimension shows Last 7/30 days checkboxes', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Created date'))

    const group = screen.getByRole('group', { name: /Created date options/i })
    expect(within(group).getByLabelText('Today')).toBeInTheDocument()
    expect(within(group).getByLabelText('This week')).toBeInTheDocument()
    expect(within(group).getByLabelText('Last 7 days')).toBeInTheDocument()
    expect(within(group).getByLabelText('Last 30 days')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 19. getTaskStates reads custom task states from localStorage
  // -----------------------------------------------------------------------
  describe('getTaskStates', () => {
    afterEach(() => {
      localStorage.removeItem('task_cycle')
    })

    it('returns default states when localStorage is empty', () => {
      expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE'])
    })

    it('reads custom states from localStorage, filtering out nulls', () => {
      localStorage.setItem(
        'task_cycle',
        JSON.stringify([null, 'TODO', 'DOING', 'DONE', 'WAITING', 'CANCELLED']),
      )
      expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE', 'WAITING', 'CANCELLED'])
    })

    it('falls back to defaults on invalid JSON', () => {
      localStorage.setItem('task_cycle', 'not-json')
      expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE'])
    })

    it('falls back to defaults when stored value is not an array', () => {
      localStorage.setItem('task_cycle', JSON.stringify('TODO'))
      expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE'])
    })
  })

  // -----------------------------------------------------------------------
  // 20. Status filter shows custom states from localStorage
  // -----------------------------------------------------------------------
  it('status filter shows custom states from localStorage', async () => {
    localStorage.setItem('task_cycle', JSON.stringify([null, 'TODO', 'DOING', 'DONE', 'WAITING']))
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Status'))

    const group = screen.getByRole('group', { name: /Status options/i })
    expect(within(group).getByLabelText('TODO')).toBeInTheDocument()
    expect(within(group).getByLabelText('DOING')).toBeInTheDocument()
    expect(within(group).getByLabelText('DONE')).toBeInTheDocument()
    expect(within(group).getByLabelText('WAITING')).toBeInTheDocument()

    localStorage.removeItem('task_cycle')
  })

  // -----------------------------------------------------------------------
  // 21. Property dimension shows in add filter popover
  // -----------------------------------------------------------------------
  it('property dimension shows in add filter popover', async () => {
    const user = userEvent.setup()
    renderBuilder()
    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    const list = screen.getByRole('list', { name: /Filter dimensions/i })
    expect(within(list).getByText('Property')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 22. Selecting Property dimension shows key picker and value input
  // -----------------------------------------------------------------------
  it('selecting Property dimension shows key picker and value input', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_property_keys') return ['project', 'effort', 'context']
      return undefined
    })

    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Property'))

    expect(screen.getByLabelText('Property key')).toBeInTheDocument()
    expect(screen.getByLabelText('Value (optional)')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 23. Property dimension is not disabled when already used
  // -----------------------------------------------------------------------
  it('property dimension is not disabled when already used', async () => {
    const user = userEvent.setup()
    const filters: AgendaFilter[] = [{ dimension: 'property', values: ['project:alpha'] }]
    renderBuilder({ filters })

    await user.click(screen.getByRole('button', { name: /Add filter/i }))

    const propertyBtn = screen.getByText('Property').closest('button')
    expect(propertyBtn).not.toBeDisabled()
  })

  // -----------------------------------------------------------------------
  // 24. Property filter chip displays key:value
  // -----------------------------------------------------------------------
  it('property filter chip displays key:value', () => {
    const filters: AgendaFilter[] = [{ dimension: 'property', values: ['project:alpha'] }]
    renderBuilder({ filters })

    expect(screen.getByText('Property:')).toBeInTheDocument()
    expect(screen.getByText('project:alpha')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Error paths
  // -----------------------------------------------------------------------

  it('tag search gracefully handles list_tags_by_prefix failure', async () => {
    const mockedInvoke = vi.mocked(invoke)
    mockedInvoke.mockRejectedValue(new Error('backend unavailable'))

    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Tag'))

    const combobox = screen.getByRole('combobox')
    await user.type(combobox, 'wor')

    // Wait for the rejected promise to settle
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'list_tags_by_prefix',
        expect.objectContaining({ prefix: 'wor' }),
      )
    })

    // Dropdown should not appear — no results on error
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Clear all filters button
  // -----------------------------------------------------------------------
  it('does not show clear-all button when no filters are active', () => {
    renderBuilder()
    expect(screen.queryByRole('button', { name: /Clear all filters/i })).not.toBeInTheDocument()
  })

  it('shows clear-all button when filters are active', () => {
    const filters: AgendaFilter[] = [{ dimension: 'status', values: ['TODO'] }]
    renderBuilder({ filters })
    expect(screen.getByRole('button', { name: /Clear all filters/i })).toBeInTheDocument()
  })

  it('clears all filters when clear-all is clicked', async () => {
    const user = userEvent.setup()
    const onFiltersChange = vi.fn()
    const filters: AgendaFilter[] = [
      { dimension: 'status', values: ['TODO'] },
      { dimension: 'priority', values: ['1'] },
    ]
    renderBuilder({ filters, onFiltersChange })

    await user.click(screen.getByRole('button', { name: /Clear all filters/i }))
    expect(onFiltersChange).toHaveBeenCalledWith([])
  })

  it('property picker gracefully handles list_property_keys failure', async () => {
    const mockedInvoke = vi.mocked(invoke)
    mockedInvoke.mockRejectedValue(new Error('backend unavailable'))

    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText('Property'))

    // Wait for the rejected promise to settle and the picker to render
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_property_keys')
    })

    // The property key select should render but with no real keys — only the placeholder
    const select = screen.getByLabelText('Property key')
    expect(select).toBeInTheDocument()
    const options = within(select).queryAllByRole('option')
    // Only the placeholder "__none__" option should be present, no real keys
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveValue('__none__')
  })
})

// ---------------------------------------------------------------------------
// AgendaSortGroupControls
// ---------------------------------------------------------------------------

describe('AgendaSortGroupControls', () => {
  const sortGroupDefaultProps: AgendaSortGroupControlsProps = {
    groupBy: 'date',
    onGroupByChange: vi.fn(),
    sortBy: 'date',
    onSortByChange: vi.fn(),
  }

  function renderSortGroup(overrides?: Partial<AgendaSortGroupControlsProps>) {
    const props = { ...sortGroupDefaultProps, ...overrides }
    return render(<AgendaSortGroupControls {...props} />)
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 19. Renders sort/group controls (buttons visible)
  it('renders sort and group control buttons', () => {
    renderSortGroup()
    expect(screen.getByLabelText('Group by')).toBeInTheDocument()
    expect(screen.getByLabelText('Sort by')).toBeInTheDocument()
  })

  // 20. Shows current selections
  it('shows current group and sort selections', () => {
    renderSortGroup({ groupBy: 'priority', sortBy: 'state' })
    expect(screen.getByLabelText('Group by')).toHaveTextContent('Priority')
    expect(screen.getByLabelText('Sort by')).toHaveTextContent('State')
  })

  // 21. Clicking group-by button shows options, selecting one calls onGroupByChange
  it('clicking group-by button shows options, selecting one calls onGroupByChange', async () => {
    const user = userEvent.setup()
    const onGroupByChange = vi.fn()
    renderSortGroup({ onGroupByChange })

    await user.click(screen.getByLabelText('Group by'))

    // All group options should be visible
    const groupList = screen.getByRole('list', { name: 'Group by' })
    expect(within(groupList).getByText('Date')).toBeInTheDocument()
    expect(within(groupList).getByText('Priority')).toBeInTheDocument()
    expect(within(groupList).getByText('State')).toBeInTheDocument()
    expect(within(groupList).getByText('None')).toBeInTheDocument()

    // Select Priority
    await user.click(within(groupList).getByText('Priority'))
    expect(onGroupByChange).toHaveBeenCalledWith('priority')
  })

  // 22. Clicking sort-by button shows options, selecting one calls onSortByChange
  it('clicking sort-by button shows options, selecting one calls onSortByChange', async () => {
    const user = userEvent.setup()
    const onSortByChange = vi.fn()
    renderSortGroup({ onSortByChange })

    await user.click(screen.getByLabelText('Sort by'))

    // All sort options should be visible
    const sortList = screen.getByRole('list', { name: 'Sort by' })
    expect(within(sortList).getByText('Date')).toBeInTheDocument()
    expect(within(sortList).getByText('Priority')).toBeInTheDocument()
    expect(within(sortList).getByText('State')).toBeInTheDocument()

    // Select State
    await user.click(within(sortList).getByText('State'))
    expect(onSortByChange).toHaveBeenCalledWith('state')
  })

  // 23. A11y audit passes with new controls
  it('a11y: no violations', async () => {
    const { container } = renderSortGroup()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
