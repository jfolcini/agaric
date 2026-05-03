/**
 * Tests for FilterPillRow component.
 *
 * Validates:
 *  - Renders nothing when filters array is empty
 *  - Renders pills for each active filter
 *  - Shows correct summary text for each filter type
 *  - Calls onRemove with correct index when X button is clicked
 *  - Calls onRemove on Delete/Backspace keydown
 *  - Uses tagResolver for HasTag pill text
 *  - Renders semantic list with correct aria-label
 *  - Each pill has a remove button with accessible aria-label
 *  - a11y compliance
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { FilterPillRow, type FilterWithKey, filterSummary } from '../FilterPillRow'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FilterPillRow', () => {
  const defaultFilters: FilterWithKey[] = [
    { type: 'BlockType', block_type: 'content', _addId: 1 },
    { type: 'Contains', query: 'test', _addId: 2 },
  ]

  it('renders nothing when filters array is empty', () => {
    const { container } = render(<FilterPillRow filters={[]} onRemove={vi.fn()} />)

    expect(container.innerHTML).toBe('')
  })

  it('renders pills for each active filter', () => {
    render(<FilterPillRow filters={defaultFilters} onRemove={vi.fn()} />)

    expect(screen.getByText('type = content')).toBeInTheDocument()
    expect(screen.getByText('contains "test"')).toBeInTheDocument()
  })

  it('renders a semantic list with correct aria-label', () => {
    const { container } = render(<FilterPillRow filters={defaultFilters} onRemove={vi.fn()} />)

    const list = container.querySelector(`ul[aria-label="${t('backlink.appliedFiltersLabel')}"]`)
    expect(list).toBeInTheDocument()
    const items = list?.querySelectorAll('li')
    expect(items).toHaveLength(2)
  })

  it('does not render list when filters are empty', () => {
    const { container } = render(<FilterPillRow filters={[]} onRemove={vi.fn()} />)

    expect(container.querySelector('ul')).not.toBeInTheDocument()
  })

  it('renders each pill with role="group" and accessible aria-label', () => {
    render(<FilterPillRow filters={defaultFilters} onRemove={vi.fn()} />)

    expect(screen.getByRole('group', { name: 'Filter: type = content' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Filter: contains "test"' })).toBeInTheDocument()
  })

  it('calls onRemove with correct index when X button is clicked', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPillRow filters={defaultFilters} onRemove={onRemove} />)

    await user.click(screen.getByLabelText('Remove filter type = content'))
    expect(onRemove).toHaveBeenCalledWith(0)

    await user.click(screen.getByLabelText('Remove filter contains "test"'))
    expect(onRemove).toHaveBeenCalledWith(1)
  })

  it('calls onRemove on Delete key press on remove button', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPillRow filters={defaultFilters} onRemove={onRemove} />)

    const removeBtn = screen.getByLabelText('Remove filter type = content')
    removeBtn.focus()
    await user.keyboard('{Delete}')

    expect(onRemove).toHaveBeenCalledWith(0)
  })

  it('calls onRemove on Backspace key press on remove button', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FilterPillRow filters={defaultFilters} onRemove={onRemove} />)

    const removeBtn = screen.getByLabelText('Remove filter contains "test"')
    removeBtn.focus()
    await user.keyboard('{Backspace}')

    expect(onRemove).toHaveBeenCalledWith(1)
  })

  it('uses tagResolver for HasTag pill display text', () => {
    const tagResolver = (id: string) => (id === 'TAG_ID_123' ? 'Project' : id)
    const filters: FilterWithKey[] = [{ type: 'HasTag', tag_id: 'TAG_ID_123', _addId: 1 }]

    render(<FilterPillRow filters={filters} onRemove={vi.fn()} tagResolver={tagResolver} />)

    expect(screen.getByText('has tag Project')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove filter has tag Project')).toBeInTheDocument()
  })

  it('truncates tag ID when no tagResolver is provided', () => {
    const filters: FilterWithKey[] = [
      { type: 'HasTag', tag_id: '01ABCDEFGHIJKLMNOPQRSTUVWX', _addId: 1 },
    ]

    render(<FilterPillRow filters={filters} onRemove={vi.fn()} />)

    expect(screen.getByText('has tag 01ABCDEF...')).toBeInTheDocument()
  })

  it('renders correct summary for various filter types', () => {
    const filters: FilterWithKey[] = [
      { type: 'PropertyText', key: 'todo', op: 'Eq', value: 'DONE', _addId: 1 },
      { type: 'PropertyNum', key: 'priority', op: 'Gt', value: 2, _addId: 2 },
      { type: 'PropertyIsSet', key: 'due', _addId: 3 },
      { type: 'PropertyIsEmpty', key: 'assignee', _addId: 4 },
      { type: 'CreatedInRange', after: '2024-01-01', before: null, _addId: 5 },
      { type: 'HasTagPrefix', prefix: 'work', _addId: 6 },
    ]

    render(<FilterPillRow filters={filters} onRemove={vi.fn()} />)

    expect(screen.getByText('status = DONE')).toBeInTheDocument()
    expect(screen.getByText('priority > 2')).toBeInTheDocument()
    expect(screen.getByText('due is set')).toBeInTheDocument()
    expect(screen.getByText('assignee is empty')).toBeInTheDocument()
    expect(screen.getByText('created after 2024-01-01')).toBeInTheDocument()
    expect(screen.getByText('tag prefix "work"')).toBeInTheDocument()
  })

  // ====================================================================
  // FE-L-14 / MAINT-190 — stable per-filter React key contract.
  //
  // `key={filter._addId}` (stamped at creation in `BacklinkFilterBuilder`)
  // replaces the old `key={index}` workaround. Re-rendering with a
  // reordered filter array must (a) not produce React duplicate-key
  // warnings and (b) preserve DOM-node identity per `_addId` so the same
  // pill follows its filter across the reorder.
  // ====================================================================
  describe('stable React key on reorder (FE-L-14)', () => {
    it('preserves per-filter <li> identity when filters are reordered', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const filtersA: FilterWithKey[] = [
          { type: 'BlockType', block_type: 'content', _addId: 101 },
          { type: 'Contains', query: 'alpha', _addId: 102 },
        ]
        const { container, rerender } = render(
          <FilterPillRow filters={filtersA} onRemove={vi.fn()} />,
        )

        const itemsBefore = Array.from(container.querySelectorAll('li'))
        expect(itemsBefore).toHaveLength(2)
        // Tag each <li> so we can detect node identity after reorder.
        itemsBefore[0]?.setAttribute('data-probe', 'first')
        itemsBefore[1]?.setAttribute('data-probe', 'second')

        // Re-render with the same filters in reverse order. Stable keys
        // mean React reorders the existing nodes rather than remounting.
        const [first, second] = filtersA as [FilterWithKey, FilterWithKey]
        const filtersB: FilterWithKey[] = [second, first]
        rerender(<FilterPillRow filters={filtersB} onRemove={vi.fn()} />)

        const itemsAfter = Array.from(container.querySelectorAll('li'))
        expect(itemsAfter).toHaveLength(2)
        // The probe attributes followed their filters across the reorder.
        expect(itemsAfter[0]?.getAttribute('data-probe')).toBe('second')
        expect(itemsAfter[1]?.getAttribute('data-probe')).toBe('first')

        const keyWarnings = consoleErrorSpy.mock.calls.filter(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('Encountered two children with the same key'),
        )
        expect(keyWarnings).toEqual([])
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })

    it('does not emit duplicate-key warnings for structurally identical filters', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // Two byte-identical filters with distinct `_addId` values — exactly
        // the case where `key={index}` would have been fine but a structural
        // hash would collide. Stable per-creation IDs avoid both pitfalls.
        const filters: FilterWithKey[] = [
          { type: 'Contains', query: 'same', _addId: 201 },
          { type: 'Contains', query: 'same', _addId: 202 },
        ]
        render(<FilterPillRow filters={filters} onRemove={vi.fn()} />)

        const keyWarnings = consoleErrorSpy.mock.calls.filter(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('Encountered two children with the same key'),
        )
        expect(keyWarnings).toEqual([])
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })
  })

  describe('filterSummary', () => {
    it('returns correct summary for PropertyDate filter', () => {
      expect(
        filterSummary({ type: 'PropertyDate', key: 'due', op: 'Lte', value: '2024-12-31' }),
      ).toBe('due <= 2024-12-31')
    })

    it('returns correct summary for CreatedInRange with both dates', () => {
      expect(
        filterSummary({ type: 'CreatedInRange', after: '2024-01-01', before: '2024-12-31' }),
      ).toBe('created after 2024-01-01 before 2024-12-31')
    })

    it('returns "filter" for unknown filter type', () => {
      // biome-ignore lint/suspicious/noExplicitAny: testing unknown filter type fallback
      expect(filterSummary({ type: 'Unknown' } as any)).toBe('filter')
    })
  })

  describe('a11y', () => {
    it('has no a11y violations with active filters', async () => {
      const { container } = render(<FilterPillRow filters={defaultFilters} onRemove={vi.fn()} />)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('has no a11y violations when empty', async () => {
      const { container } = render(<FilterPillRow filters={[]} onRemove={vi.fn()} />)

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
