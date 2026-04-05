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
import type { BacklinkFilter } from '../../lib/tauri'
import { FilterPillRow, filterSummary } from '../FilterPillRow'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FilterPillRow', () => {
  const defaultFilters: BacklinkFilter[] = [
    { type: 'BlockType', block_type: 'content' },
    { type: 'Contains', query: 'test' },
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

    const list = container.querySelector('ul[aria-label="Applied filters"]')
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
    const filters: BacklinkFilter[] = [{ type: 'HasTag', tag_id: 'TAG_ID_123' }]

    render(<FilterPillRow filters={filters} onRemove={vi.fn()} tagResolver={tagResolver} />)

    expect(screen.getByText('has tag Project')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove filter has tag Project')).toBeInTheDocument()
  })

  it('truncates tag ID when no tagResolver is provided', () => {
    const filters: BacklinkFilter[] = [{ type: 'HasTag', tag_id: '01ABCDEFGHIJKLMNOPQRSTUVWX' }]

    render(<FilterPillRow filters={filters} onRemove={vi.fn()} />)

    expect(screen.getByText('has tag 01ABCDEF...')).toBeInTheDocument()
  })

  it('renders correct summary for various filter types', () => {
    const filters: BacklinkFilter[] = [
      { type: 'PropertyText', key: 'todo', op: 'Eq', value: 'DONE' },
      { type: 'PropertyNum', key: 'priority', op: 'Gt', value: 2 },
      { type: 'PropertyIsSet', key: 'due' },
      { type: 'PropertyIsEmpty', key: 'assignee' },
      { type: 'CreatedInRange', after: '2024-01-01', before: null },
      { type: 'HasTagPrefix', prefix: 'work' },
    ]

    render(<FilterPillRow filters={filters} onRemove={vi.fn()} />)

    expect(screen.getByText('status = DONE')).toBeInTheDocument()
    expect(screen.getByText('priority > 2')).toBeInTheDocument()
    expect(screen.getByText('due is set')).toBeInTheDocument()
    expect(screen.getByText('assignee is empty')).toBeInTheDocument()
    expect(screen.getByText('created after 2024-01-01')).toBeInTheDocument()
    expect(screen.getByText('tag prefix "work"')).toBeInTheDocument()
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
