/**
 * Tests for GraphFilterBar component (UX-205).
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { GraphFilter } from '@/lib/graph-filters'
import { t } from '@/lib/i18n'
import { GraphFilterBar } from '../GraphFilterBar'

// Mock Popover to avoid Radix portal / positioning issues in jsdom — matches
// the pattern used in SourcePageFilter.test.tsx.
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

const sampleTags = [
  { tag_id: 'tag-1', name: 'Work' },
  { tag_id: 'tag-2', name: 'Home' },
]

describe('GraphFilterBar', () => {
  let onFiltersChange: ReturnType<typeof vi.fn<(filters: GraphFilter[]) => void>>

  beforeEach(() => {
    onFiltersChange = vi.fn<(filters: GraphFilter[]) => void>()
  })

  it('renders the add-filter button and no pills when no filters are active', () => {
    render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />)

    expect(screen.getByRole('button', { name: t('graph.filter.addFilter') })).toBeInTheDocument()
    expect(screen.getByText(t('graph.filter.noFilters'))).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: t('graph.filter.clearAll') }),
    ).not.toBeInTheDocument()
  })

  it('renders a pill for each active filter', () => {
    const filters: GraphFilter[] = [
      { type: 'status', values: ['TODO'] },
      { type: 'hasDueDate', value: true },
    ]
    render(
      <GraphFilterBar filters={filters} onFiltersChange={onFiltersChange} allTags={sampleTags} />,
    )

    // Status pill label contains "Status: TODO"
    expect(screen.getByText(/Status.*TODO/)).toBeInTheDocument()
    // Has due date pill contains "Has due date: Yes"
    expect(screen.getByText(/Has due date.*Yes/)).toBeInTheDocument()
  })

  it('renders the "Clear all" button when filters are active', () => {
    const filters: GraphFilter[] = [{ type: 'status', values: ['TODO'] }]
    render(
      <GraphFilterBar filters={filters} onFiltersChange={onFiltersChange} allTags={sampleTags} />,
    )

    expect(screen.getByRole('button', { name: t('graph.filter.clearAll') })).toBeInTheDocument()
  })

  it('calls onFiltersChange with an empty array when Clear all is clicked', async () => {
    const user = userEvent.setup()
    const filters: GraphFilter[] = [
      { type: 'status', values: ['TODO'] },
      { type: 'priority', values: ['1'] },
    ]
    render(
      <GraphFilterBar filters={filters} onFiltersChange={onFiltersChange} allTags={sampleTags} />,
    )

    await user.click(screen.getByRole('button', { name: t('graph.filter.clearAll') }))
    expect(onFiltersChange).toHaveBeenCalledWith([])
  })

  it('calls onFiltersChange with the filter removed when pill remove is clicked', async () => {
    const user = userEvent.setup()
    const filters: GraphFilter[] = [
      { type: 'status', values: ['TODO'] },
      { type: 'hasDueDate', value: true },
    ]
    render(
      <GraphFilterBar filters={filters} onFiltersChange={onFiltersChange} allTags={sampleTags} />,
    )

    const removeButtons = screen.getAllByRole('button', {
      name: /Remove.*filter/i,
    })
    await user.click(removeButtons[0] as HTMLElement)

    expect(onFiltersChange).toHaveBeenCalledTimes(1)
    const nextFilters = onFiltersChange.mock.calls[0]?.[0] as GraphFilter[]
    expect(nextFilters).toHaveLength(1)
  })

  it('adds a status filter via the add-filter form', async () => {
    const user = userEvent.setup()
    render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />)

    // Select the status dimension from the dimension selector.
    // The mocked Select renders as a native <select> labelled "Select a dimension".
    const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
    await user.selectOptions(dimensionSelect, 'status')

    // Check TODO
    const todoCheckbox = screen.getByRole('checkbox', {
      name: t('graph.filter.statusValue.TODO'),
    })
    await user.click(todoCheckbox)

    // Click Apply
    const applyButton = screen.getByRole('button', { name: t('graph.filter.apply') })
    await user.click(applyButton)

    expect(onFiltersChange).toHaveBeenCalledWith([{ type: 'status', values: ['TODO'] }])
  })

  it('adds a hasBacklinks filter with the selected boolean value', async () => {
    const user = userEvent.setup()
    render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />)

    const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
    await user.selectOptions(dimensionSelect, 'hasBacklinks')

    // The boolean select (labelled with the dimension name) defaults to "true".
    const applyButton = screen.getByRole('button', { name: t('graph.filter.apply') })
    await user.click(applyButton)

    expect(onFiltersChange).toHaveBeenCalledWith([{ type: 'hasBacklinks', value: true }])
  })

  it('adds a tag filter with multiple selected tags', async () => {
    const user = userEvent.setup()
    render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />)

    const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
    await user.selectOptions(dimensionSelect, 'tag')

    await user.click(screen.getByRole('checkbox', { name: 'Work' }))
    await user.click(screen.getByRole('checkbox', { name: 'Home' }))
    await user.click(screen.getByRole('button', { name: t('graph.filter.apply') }))

    expect(onFiltersChange).toHaveBeenCalledWith([{ type: 'tag', tagIds: ['tag-1', 'tag-2'] }])
  })

  it('adds an excludeTemplates filter', async () => {
    const user = userEvent.setup()
    render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />)

    const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
    await user.selectOptions(dimensionSelect, 'excludeTemplates')
    await user.click(screen.getByRole('button', { name: t('graph.filter.apply') }))

    expect(onFiltersChange).toHaveBeenCalledWith([{ type: 'excludeTemplates', value: true }])
  })

  it('shows the no-tags message when allTags is empty', async () => {
    const user = userEvent.setup()
    render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={[]} />)

    const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
    await user.selectOptions(dimensionSelect, 'tag')
    expect(screen.getByText(t('graph.filter.tagNoTags'))).toBeInTheDocument()
  })

  it('shows filter count when filteredCount differs from totalCount', () => {
    const filters: GraphFilter[] = [{ type: 'status', values: ['TODO'] }]
    render(
      <GraphFilterBar
        filters={filters}
        onFiltersChange={onFiltersChange}
        allTags={sampleTags}
        totalCount={10}
        filteredCount={3}
      />,
    )

    expect(screen.getByTestId('graph-filter-count')).toHaveTextContent(
      t('graph.filter.showingCount', { filtered: 3, total: 10 }),
    )
  })

  it('hides filter count when counts are equal (no filters active)', () => {
    render(
      <GraphFilterBar
        filters={[]}
        onFiltersChange={onFiltersChange}
        allTags={sampleTags}
        totalCount={10}
        filteredCount={10}
      />,
    )

    expect(screen.queryByTestId('graph-filter-count')).not.toBeInTheDocument()
  })

  it('hides already-used dimensions from the add-filter selector', async () => {
    const user = userEvent.setup()
    const filters: GraphFilter[] = [{ type: 'status', values: ['TODO'] }]
    render(
      <GraphFilterBar filters={filters} onFiltersChange={onFiltersChange} allTags={sampleTags} />,
    )

    const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
    await user.click(dimensionSelect)
    // The "status" option should not be present since it's already active.
    expect(
      (dimensionSelect as HTMLSelectElement).querySelector('option[value="status"]'),
    ).toBeNull()
    // But priority should still be available.
    expect(
      (dimensionSelect as HTMLSelectElement).querySelector('option[value="priority"]'),
    ).not.toBeNull()
  })

  it('Apply button is disabled until a dimension is selected', () => {
    render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />)

    const applyButton = screen.getByRole('button', { name: t('graph.filter.apply') })
    expect(applyButton).toBeDisabled()
  })

  it('renders an aria-live region announcing the active filter count', () => {
    const filters: GraphFilter[] = [
      { type: 'status', values: ['TODO'] },
      { type: 'priority', values: ['1'] },
    ]
    const { container } = render(
      <GraphFilterBar filters={filters} onFiltersChange={onFiltersChange} allTags={sampleTags} />,
    )
    const liveRegion = container.querySelector('[aria-live="polite"]')
    expect(liveRegion).not.toBeNull()
  })

  it('has no a11y violations with no filters', async () => {
    const { container } = render(
      <GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with active filters', async () => {
    const filters: GraphFilter[] = [
      { type: 'status', values: ['TODO'] },
      { type: 'hasDueDate', value: true },
    ]
    const { container } = render(
      <GraphFilterBar
        filters={filters}
        onFiltersChange={onFiltersChange}
        allTags={sampleTags}
        totalCount={10}
        filteredCount={3}
      />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
