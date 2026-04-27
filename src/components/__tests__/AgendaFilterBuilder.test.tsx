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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

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

    const list = screen.getByLabelText(t('agendaFilter.appliedFilters'))
    expect(list).toBeInTheDocument()
    expect(within(list).getByText(`${t('agendaFilter.status')}:`)).toBeInTheDocument()
    expect(within(list).getByText('TODO')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 3. Chip shows dimension label and values (multiple values)
  // -----------------------------------------------------------------------
  it('chip displays dimension label and comma-separated values', () => {
    const filters: AgendaFilter[] = [{ dimension: 'status', values: ['TODO', 'DOING'] }]
    renderBuilder({ filters })

    expect(screen.getByText(`${t('agendaFilter.status')}:`)).toBeInTheDocument()
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
    await user.click(
      screen.getByLabelText(
        t('agendaFilter.removeFilterLabel', { label: t('agendaFilter.status') }),
      ),
    )

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

    expect(screen.getByText(t('agendaFilter.combinedWithAnd'))).toBeInTheDocument()
  })

  it('does not show "Filters combined with AND" with only 1 filter', () => {
    const filters: AgendaFilter[] = [{ dimension: 'status', values: ['TODO'] }]
    renderBuilder({ filters })

    expect(screen.queryByText(t('agendaFilter.combinedWithAnd'))).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 6. Add filter dropdown shows all dimension options
  // -----------------------------------------------------------------------
  it('add filter popover shows all dimension options', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))

    const list = screen.getByRole('list', { name: /Filter dimensions/i })
    expect(within(list).getByText(t('agendaFilter.status'))).toBeInTheDocument()
    expect(within(list).getByText(t('agendaFilter.priority'))).toBeInTheDocument()
    expect(within(list).getByText(t('agendaFilter.dueDate'))).toBeInTheDocument()
    expect(within(list).getByText(t('agendaFilter.createdDate'))).toBeInTheDocument()
    expect(within(list).getByText(t('agendaFilter.tag'))).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // UX-9: dimension picker carries a Tooltip describing each dimension
  // -----------------------------------------------------------------------
  it('renders a tooltip describing each dimension when hovered (UX-9)', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))

    // Hover the dueDate row — its tooltip explains the contrast with
    // scheduledDate, which is the whole point of the discoverability fix.
    const dueDateBtn = screen
      .getByText(t('agendaFilter.dueDate'))
      .closest('button') as HTMLButtonElement | null
    expect(dueDateBtn).not.toBeNull()
    // The Tooltip wraps the menu item in a `<span>`. Hover the span so
    // disabled-button pointer handling does not swallow the event.
    const triggerSpan = (dueDateBtn as HTMLButtonElement).parentElement as HTMLElement
    expect(triggerSpan).not.toBeNull()
    await user.hover(triggerSpan)

    await waitFor(
      async () => {
        const matches = await screen.findAllByText(t('filter.dimension.dueDate.description'))
        expect(matches.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 3000 },
    )
  })

  // -----------------------------------------------------------------------
  // 7. Selecting Status dimension shows TODO/DOING/DONE checkboxes
  // -----------------------------------------------------------------------
  it('selecting Status dimension shows TODO/DOING/DONE checkboxes', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText(t('agendaFilter.status')))

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
    await user.click(screen.getByText(t('agendaFilter.priority')))

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
    await user.click(screen.getByText(t('agendaFilter.tag')))

    expect(screen.getByLabelText(t('agendaFilter.tagName'))).toBeInTheDocument()
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
    await user.click(screen.getByText(t('agendaFilter.tag')))

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

    const statusBtn = screen.getByText(t('agendaFilter.status')).closest('button')
    expect(statusBtn).toBeDisabled()

    const priorityBtn = screen.getByText(t('agendaFilter.priority')).closest('button')
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
    await user.click(screen.getByText(t('agendaFilter.status')))

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
    await user.click(screen.getByText(t('agendaFilter.status')))

    const applyBtn = screen.getByRole('button', { name: /Apply filter/i })
    expect(applyBtn).toBeDisabled()

    // Check a value
    await user.click(screen.getByLabelText('TODO'))
    expect(applyBtn).not.toBeDisabled()
  })

  // -----------------------------------------------------------------------
  // 13b. (UX-274) Disabled apply button surfaces visual feedback via Button
  //     primitive's `disabled:` Tailwind modifiers.
  // -----------------------------------------------------------------------
  it('apply button shows disabled visual styling (opacity + cursor)', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText(t('agendaFilter.status')))

    const applyBtn = screen.getByRole('button', { name: /Apply filter/i })
    expect(applyBtn).toBeDisabled()
    // Button primitive bakes these in — they are the visual cue users see.
    expect(applyBtn.className).toContain('disabled:opacity-50')
    expect(applyBtn.className).toContain('disabled:cursor-not-allowed')
  })

  // -----------------------------------------------------------------------
  // 14. Fieldset has proper sr-only legend
  // -----------------------------------------------------------------------
  it('renders sr-only legend inside fieldset', () => {
    const { container } = renderBuilder()
    const legend = container.querySelector('fieldset legend')
    expect(legend).toBeInTheDocument()
    expect(legend).toHaveTextContent(t('agendaFilter.agendaFilters'))
    expect(legend).toHaveClass('sr-only')
  })

  // -----------------------------------------------------------------------
  // 15. Does not render applied filters list when no filters active
  // -----------------------------------------------------------------------
  it('does not render applied filters list when no filters active', () => {
    const { container } = renderBuilder()
    expect(
      container.querySelector(`ul[aria-label="${t('agendaFilter.appliedFilters')}"]`),
    ).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 16. dueDate dimension shows all 6 choices including new presets
  // -----------------------------------------------------------------------
  it('dueDate dimension shows all 6 choices including new presets', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText(t('agendaFilter.dueDate')))

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
    await user.click(screen.getByText(t('agendaFilter.scheduledDate')))
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
    expect(within(list).getByText(t('agendaFilter.completedDate'))).toBeInTheDocument()
  })

  it('completedDate dimension shows past-oriented choices', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText(t('agendaFilter.completedDate')))

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
    await user.click(screen.getByText(t('agendaFilter.completedDate')))

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
    await user.click(screen.getByText(t('agendaFilter.createdDate')))
    const group = screen.getByRole('group', { name: /Created date options/i })
    expect(within(group).getByLabelText('Today')).toBeInTheDocument()
    expect(within(group).getByLabelText('This week')).toBeInTheDocument()
    expect(within(group).getByLabelText('Last 7 days')).toBeInTheDocument()
    expect(within(group).getByLabelText('Last 30 days')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 19. getTaskStates returns the fixed locked cycle (UX-202)
  // -----------------------------------------------------------------------
  describe('getTaskStates', () => {
    it('returns the locked fixed cycle TODO/DOING/DONE/CANCELLED (UX-234)', () => {
      expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE', 'CANCELLED'])
    })

    it('ignores legacy localStorage values (UX-202)', () => {
      localStorage.setItem('task_cycle', JSON.stringify([null, 'TODO', 'DOING', 'DONE', 'WAITING']))
      try {
        expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE', 'CANCELLED'])
      } finally {
        localStorage.removeItem('task_cycle')
      }
    })
  })

  // -----------------------------------------------------------------------
  // 20. Status filter shows the fixed cycle (UX-202: includes CANCELLED)
  // -----------------------------------------------------------------------
  it('status filter shows the fixed cycle including CANCELLED (UX-202)', async () => {
    const user = userEvent.setup()
    renderBuilder()

    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    await user.click(screen.getByText(t('agendaFilter.status')))

    const group = screen.getByRole('group', { name: /Status options/i })
    expect(within(group).getByLabelText('TODO')).toBeInTheDocument()
    expect(within(group).getByLabelText('DOING')).toBeInTheDocument()
    expect(within(group).getByLabelText('CANCELLED')).toBeInTheDocument()
    expect(within(group).getByLabelText('DONE')).toBeInTheDocument()
    // Legacy custom state should NOT appear — the cycle is now locked.
    expect(within(group).queryByLabelText('WAITING')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 21. Property dimension shows in add filter popover
  // -----------------------------------------------------------------------
  it('property dimension shows in add filter popover', async () => {
    const user = userEvent.setup()
    renderBuilder()
    await user.click(screen.getByRole('button', { name: /Add filter/i }))
    const list = screen.getByRole('list', { name: /Filter dimensions/i })
    expect(within(list).getByText(t('agendaFilter.property'))).toBeInTheDocument()
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
    await user.click(screen.getByText(t('agendaFilter.property')))

    expect(screen.getByLabelText(t('agendaFilter.propertyKey'))).toBeInTheDocument()
    expect(screen.getByLabelText(t('agendaFilter.propertyValue'))).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 23. Property dimension is not disabled when already used
  // -----------------------------------------------------------------------
  it('property dimension is not disabled when already used', async () => {
    const user = userEvent.setup()
    const filters: AgendaFilter[] = [{ dimension: 'property', values: ['project:alpha'] }]
    renderBuilder({ filters })

    await user.click(screen.getByRole('button', { name: /Add filter/i }))

    const propertyBtn = screen.getByText(t('agendaFilter.property')).closest('button')
    expect(propertyBtn).not.toBeDisabled()
  })

  // -----------------------------------------------------------------------
  // 24. Property filter chip displays key = value
  // -----------------------------------------------------------------------
  it('property filter chip displays key = value', () => {
    const filters: AgendaFilter[] = [{ dimension: 'property', values: ['project:alpha'] }]
    renderBuilder({ filters })

    expect(screen.getByText('project = alpha')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 24b. Property filter chip shows key only when no value
  // -----------------------------------------------------------------------
  it('property filter chip shows key only when no value', () => {
    const filters: AgendaFilter[] = [{ dimension: 'property', values: ['project'] }]
    renderBuilder({ filters })

    expect(screen.getByText('project')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // 24c. Property filter chip has tooltip
  // -----------------------------------------------------------------------
  it('property filter chip has tooltip', () => {
    const filters: AgendaFilter[] = [{ dimension: 'property', values: ['project:alpha'] }]
    renderBuilder({ filters })

    const editButton = screen.getByText('project = alpha').closest('button')
    expect(editButton).toHaveAttribute('title', 'project = alpha')
  })

  // -----------------------------------------------------------------------
  // 24d. Property filter chip aria-label uses formatted label
  // -----------------------------------------------------------------------
  it('property filter chip aria-label uses formatted label', () => {
    const filters: AgendaFilter[] = [{ dimension: 'property', values: ['project:alpha'] }]
    renderBuilder({ filters })

    const editButton = screen.getByText('project = alpha').closest('button')
    expect(editButton).toHaveAttribute('aria-label', expect.stringContaining('project = alpha'))
  })

  // -----------------------------------------------------------------------
  // 24e. Non-property filter chip is unchanged
  // -----------------------------------------------------------------------
  it('non-property filter chip unchanged', () => {
    const filters: AgendaFilter[] = [{ dimension: 'status', values: ['TODO'] }]
    renderBuilder({ filters })

    expect(screen.getByText(`${t('agendaFilter.status')}:`)).toBeInTheDocument()
    expect(screen.getByText('TODO')).toBeInTheDocument()
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
    await user.click(screen.getByText(t('agendaFilter.tag')))

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
    await user.click(screen.getByText(t('agendaFilter.property')))

    // Wait for the rejected promise to settle and the picker to render
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_property_keys')
    })

    // The property key select should render but with no real keys — only the placeholder
    const select = screen.getByLabelText(t('agendaFilter.propertyKey'))
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
    expect(screen.getByLabelText(t('agenda.groupBy'))).toBeInTheDocument()
    expect(screen.getByLabelText(t('agenda.sortBy'))).toBeInTheDocument()
  })

  // 20. Shows current selections
  it('shows current group and sort selections', () => {
    renderSortGroup({ groupBy: 'priority', sortBy: 'state' })
    expect(screen.getByLabelText(t('agenda.groupBy'))).toHaveTextContent(t('agenda.groupPriority'))
    expect(screen.getByLabelText(t('agenda.sortBy'))).toHaveTextContent(t('agenda.sortState'))
  })

  // 21. Clicking group-by button shows options, selecting one calls onGroupByChange
  it('clicking group-by button shows options, selecting one calls onGroupByChange', async () => {
    const user = userEvent.setup()
    const onGroupByChange = vi.fn()
    renderSortGroup({ onGroupByChange })

    await user.click(screen.getByLabelText(t('agenda.groupBy')))

    // All group options should be visible
    const groupList = screen.getByRole('list', { name: t('agenda.groupBy') })
    expect(within(groupList).getByText(t('agenda.groupDate'))).toBeInTheDocument()
    expect(within(groupList).getByText(t('agenda.groupPriority'))).toBeInTheDocument()
    expect(within(groupList).getByText(t('agenda.groupState'))).toBeInTheDocument()
    expect(within(groupList).getByText(t('agenda.groupNone'))).toBeInTheDocument()

    // Select Priority
    await user.click(within(groupList).getByText(t('agenda.groupPriority')))
    expect(onGroupByChange).toHaveBeenCalledWith('priority')
  })

  // 22. Clicking sort-by button shows options, selecting one calls onSortByChange
  it('clicking sort-by button shows options, selecting one calls onSortByChange', async () => {
    const user = userEvent.setup()
    const onSortByChange = vi.fn()
    renderSortGroup({ onSortByChange })

    await user.click(screen.getByLabelText(t('agenda.sortBy')))

    // All sort options should be visible
    const sortList = screen.getByRole('list', { name: t('agenda.sortBy') })
    expect(within(sortList).getByText(t('agenda.sortDate'))).toBeInTheDocument()
    expect(within(sortList).getByText(t('agenda.sortPriority'))).toBeInTheDocument()
    expect(within(sortList).getByText(t('agenda.sortState'))).toBeInTheDocument()

    // Select State
    await user.click(within(sortList).getByText(t('agenda.sortState')))
    expect(onSortByChange).toHaveBeenCalledWith('state')
  })

  // 23. A11y audit passes with new controls
  it('a11y: no violations', async () => {
    const { container } = renderSortGroup()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
