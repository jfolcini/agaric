/**
 * Tests for GraphFilterBar component (UX-205, UX-270).
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { GraphFilter } from '@/lib/graph-filters'
import { t } from '@/lib/i18n'
import { __resetPriorityLevelsForTests, setPriorityLevels } from '@/lib/priority-levels'
import { GraphFilterBar } from '../GraphFilterBar'

// UX-270: silence the logger.warn calls emitted by readPersistedFilters /
// writePersistedFilters when storage is corrupted or throws.
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

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

// UX-270: stateful harness mirroring the parent contract in `GraphView` —
// holds the controlled `filters` state so the persistence effects can dispatch
// through `onFiltersChange` and re-render the component with the hydrated
// value.
function StatefulHarness({
  initialFilters = [],
  onChange,
  allTags = sampleTags,
}: {
  initialFilters?: GraphFilter[]
  onChange?: (filters: GraphFilter[]) => void
  allTags?: typeof sampleTags
}): React.ReactElement {
  const [filters, setFilters] = useState<GraphFilter[]>(initialFilters)
  return (
    <GraphFilterBar
      filters={filters}
      onFiltersChange={(next) => {
        setFilters(next)
        onChange?.(next)
      }}
      allTags={allTags}
    />
  )
}

describe('GraphFilterBar', () => {
  let onFiltersChange: ReturnType<typeof vi.fn<(filters: GraphFilter[]) => void>>

  beforeEach(() => {
    onFiltersChange = vi.fn<(filters: GraphFilter[]) => void>()
    __resetPriorityLevelsForTests()
    // UX-270: clear persisted filters between tests so localStorage state
    // from an earlier test (or the StatefulHarness write effect) does not
    // leak into the next run.
    localStorage.removeItem('agaric:graph-filters')
  })

  afterEach(() => {
    __resetPriorityLevelsForTests()
    localStorage.removeItem('agaric:graph-filters')
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

  // UX-201b: priority filter checkboxes reflect the user-configured level set.
  describe('priority level subscription (UX-201b)', () => {
    it('renders priority checkboxes for custom user-configured levels', async () => {
      setPriorityLevels(['High', 'Mid', 'Low'])
      const user = userEvent.setup()
      render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />)

      const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
      await user.selectOptions(dimensionSelect, 'priority')

      // Default-valued i18n fallback is `P${level}` — three custom checkboxes.
      expect(screen.getByRole('checkbox', { name: 'PHigh' })).toBeInTheDocument()
      expect(screen.getByRole('checkbox', { name: 'PMid' })).toBeInTheDocument()
      expect(screen.getByRole('checkbox', { name: 'PLow' })).toBeInTheDocument()
      // The default '1', '2', '3' checkboxes are not rendered.
      expect(screen.queryByRole('checkbox', { name: 'P1' })).not.toBeInTheDocument()
    })

    it('re-renders when levels change via setPriorityLevels after mount', async () => {
      const user = userEvent.setup()
      render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />)

      const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
      await user.selectOptions(dimensionSelect, 'priority')

      // Defaults: 1/2/3 resolve through i18n to their translated labels.
      expect(
        screen.getByRole('checkbox', { name: t('graph.filter.priorityValue.1') }),
      ).toBeInTheDocument()
      // P5 not present yet.
      expect(screen.queryByRole('checkbox', { name: 'P5' })).not.toBeInTheDocument()

      // Live update — subscribe pushes new levels.
      setPriorityLevels(['1', '2', '3', '4', '5'])

      // Levels 4 and 5 have no i18n keys, so they render via the `P${level}`
      // defaultValue fallback.
      await waitFor(() => {
        expect(screen.getByRole('checkbox', { name: 'P4' })).toBeInTheDocument()
        expect(screen.getByRole('checkbox', { name: 'P5' })).toBeInTheDocument()
      })
    })
  })

  // -------------------------------------------------------------------------
  // UX-270: a11y + filter persistence
  // -------------------------------------------------------------------------

  describe('tag list scroll container (UX-270)', () => {
    it('uses the shared ScrollArea primitive (no bare overflow-y-auto)', async () => {
      const user = userEvent.setup()
      const { container } = render(
        <GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />,
      )

      const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
      await user.selectOptions(dimensionSelect, 'tag')

      // ScrollArea exposes `data-slot="scroll-area"` on its Root.
      const scrollArea = container.querySelector('[data-slot="scroll-area"]')
      expect(scrollArea).not.toBeNull()
      // The replaced bare scroller must no longer be present.
      expect(container.querySelector('div.overflow-y-auto')).toBeNull()
    })
  })

  describe('tag checkbox accessible name (UX-270)', () => {
    it('checkbox has no redundant aria-label (label element provides the name)', async () => {
      const user = userEvent.setup()
      render(<GraphFilterBar filters={[]} onFiltersChange={onFiltersChange} allTags={sampleTags} />)

      const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
      await user.selectOptions(dimensionSelect, 'tag')

      // The checkbox is still findable by its visible label text — that
      // single source of truth is what we want.
      const workCheckbox = screen.getByRole('checkbox', { name: 'Work' })
      expect(workCheckbox).toBeInTheDocument()
      expect(workCheckbox).not.toHaveAttribute('aria-label')
    })
  })

  describe('filter persistence (UX-270)', () => {
    const STORAGE_KEY = 'agaric:graph-filters'

    it('hydrates filters from localStorage on mount', async () => {
      const stored: GraphFilter[] = [{ type: 'status', values: ['TODO'] }]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

      const onChange = vi.fn<(filters: GraphFilter[]) => void>()
      render(<StatefulHarness onChange={onChange} />)

      // The hydration effect dispatches the persisted list through the
      // controlled `onFiltersChange` callback.
      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(stored)
      })
      // …and the rehydrated pill is rendered.
      await waitFor(() => {
        expect(screen.getByText(/Status.*TODO/)).toBeInTheDocument()
      })
    })

    it('writes the active filter list to localStorage on every change', async () => {
      const user = userEvent.setup()
      render(<StatefulHarness />)

      // Add a status=TODO filter via the popover form.
      const dimensionSelect = screen.getByLabelText(t('graph.filter.selectDimension'))
      await user.selectOptions(dimensionSelect, 'status')
      await user.click(screen.getByRole('checkbox', { name: t('graph.filter.statusValue.TODO') }))
      await user.click(screen.getByRole('button', { name: t('graph.filter.apply') }))

      await waitFor(() => {
        const raw = localStorage.getItem(STORAGE_KEY)
        expect(raw).not.toBeNull()
        const parsed = JSON.parse(raw ?? '[]') as GraphFilter[]
        expect(parsed).toEqual([{ type: 'status', values: ['TODO'] }])
      })
    })

    it('rehydrates the filter on remount after unmount (cross-navigation)', async () => {
      const stored: GraphFilter[] = [
        { type: 'status', values: ['TODO'] },
        { type: 'hasDueDate', value: true },
      ]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

      // First mount — hydrates and renders the persisted pills.
      const first = render(<StatefulHarness />)
      await waitFor(() => {
        expect(screen.getByText(/Status.*TODO/)).toBeInTheDocument()
      })
      first.unmount()

      // Second mount — fresh `useState([])` in the harness; if persistence
      // works, the component should re-hydrate from localStorage and the
      // pills should reappear.
      render(<StatefulHarness />)
      await waitFor(() => {
        expect(screen.getByText(/Status.*TODO/)).toBeInTheDocument()
        expect(screen.getByText(/Has due date.*Yes/)).toBeInTheDocument()
      })
    })

    it('survives corrupted JSON in localStorage (try/catch)', async () => {
      localStorage.setItem(STORAGE_KEY, '{not valid json')

      const onChange = vi.fn<(filters: GraphFilter[]) => void>()
      const { container } = render(<StatefulHarness onChange={onChange} />)

      // Component should still render the empty-state badge — no crash.
      expect(screen.getByText(t('graph.filter.noFilters'))).toBeInTheDocument()
      // Hydration must not have dispatched a corrupt value upstream.
      await waitFor(() => {
        // Allow microtasks to settle; if no dispatch happened, callback
        // remains uninvoked.
        expect(onChange).not.toHaveBeenCalled()
      })
      // And the bar still passes the a11y audit.
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('ignores non-array stored values (try/catch + array guard)', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }))

      const onChange = vi.fn<(filters: GraphFilter[]) => void>()
      render(<StatefulHarness onChange={onChange} />)

      await waitFor(() => {
        expect(onChange).not.toHaveBeenCalled()
      })
      expect(screen.getByText(t('graph.filter.noFilters'))).toBeInTheDocument()
    })

    it('persists filter clears (writes empty array on Clear all)', async () => {
      const user = userEvent.setup()
      const stored: GraphFilter[] = [{ type: 'status', values: ['TODO'] }]
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

      render(<StatefulHarness />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: t('graph.filter.clearAll') })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: t('graph.filter.clearAll') }))

      await waitFor(() => {
        const raw = localStorage.getItem(STORAGE_KEY)
        expect(raw).toBe(JSON.stringify([]))
      })
    })
  })
})
