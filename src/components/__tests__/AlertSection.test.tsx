/**
 * Tests for AlertSection shared component.
 *
 * Validates:
 *  - Renders with destructive variant (overdue mode)
 *  - Renders with pending variant (upcoming mode)
 *  - Returns null for empty blocks
 *  - Shows todo_state badge when present
 *  - Shows PriorityBadge when showPriorityBadge is true
 *  - Hides PriorityBadge when showPriorityBadge is false/default
 *  - Sorts blocks by due_date ascending
 *  - Navigation on click
 *  - Navigation on keyboard (Enter)
 *  - Does not navigate when parent_id is null
 *  - Renders due_date for each block
 *  - a11y audit passes (axe) for both variants and empty state
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { BlockRow } from '../../lib/tauri'
import { AlertSection } from '../AlertSection'

function makeBlock(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'B1',
    block_type: 'block',
    content: 'test block',
    parent_id: 'PAGE1',
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: 'TODO',
    priority: null,
    due_date: '2025-01-01',
    scheduled_date: null,
    ...overrides,
  }
}

describe('AlertSection', () => {
  const defaultTitles = new Map([['PAGE1', 'My Page']])

  it('renders title and count badge with destructive variant', () => {
    const blocks = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2', content: 'second' })]

    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={blocks}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('Overdue')).toBeInTheDocument()
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('renders title and count badge with pending variant', () => {
    const blocks = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2', content: 'second' })]

    render(
      <AlertSection
        variant="pending"
        title="Upcoming"
        blocks={blocks}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('Upcoming')).toBeInTheDocument()
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('returns null when blocks array is empty', () => {
    const { container } = render(
      <AlertSection variant="destructive" title="Overdue" blocks={[]} pageTitles={new Map()} />,
    )

    expect(container.innerHTML).toBe('')
  })

  it('shows todo_state badge when present', () => {
    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', todo_state: 'TODO' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('TODO')).toBeInTheDocument()
  })

  it('shows priority badge when showPriorityBadge is true', () => {
    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', priority: '1' })]}
        pageTitles={defaultTitles}
        showPriorityBadge
      />,
    )

    expect(screen.getByText('P1')).toBeInTheDocument()
  })

  it('does not show priority badge when showPriorityBadge is false', () => {
    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', priority: '1' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.queryByText('P1')).not.toBeInTheDocument()
  })

  it('does not show priority badge with pending variant by default', () => {
    render(
      <AlertSection
        variant="pending"
        title="Upcoming"
        blocks={[makeBlock({ id: 'B1', priority: '1' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.queryByText('P1')).not.toBeInTheDocument()
  })

  it('sorts blocks by due_date ascending', () => {
    const blocks = [
      makeBlock({ id: 'B1', content: 'later', due_date: '2025-03-01' }),
      makeBlock({ id: 'B2', content: 'earlier', due_date: '2025-01-15' }),
      makeBlock({ id: 'B3', content: 'middle', due_date: '2025-02-01' }),
    ]

    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={blocks}
        pageTitles={defaultTitles}
      />,
    )

    const items = screen.getAllByText(/earlier|middle|later/)
    expect(items[0]).toHaveTextContent('earlier')
    expect(items[1]).toHaveTextContent('middle')
    expect(items[2]).toHaveTextContent('later')
  })

  it('navigates to parent page on click', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'BK1', parent_id: 'PAGE1', content: 'click me' })]}
        pageTitles={new Map([['PAGE1', 'Source Page']])}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('click me')
    await user.click(item.closest('li') as HTMLElement)

    expect(onNavigate).toHaveBeenCalledWith('PAGE1', 'Source Page', 'BK1')
  })

  it('navigates to parent page on Enter key', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <AlertSection
        variant="pending"
        title="Upcoming"
        blocks={[makeBlock({ id: 'BK2', parent_id: 'PAGE1', content: 'key block' })]}
        pageTitles={new Map([['PAGE1', 'Key Page']])}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('key block')
    const li = item.closest('li') as HTMLElement
    li.focus()
    await user.keyboard('{Enter}')

    expect(onNavigate).toHaveBeenCalledWith('PAGE1', 'Key Page', 'BK2')
  })

  it('does not navigate when parent_id is null', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', parent_id: null, content: 'orphan' })]}
        pageTitles={new Map()}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('orphan')
    await user.click(item.closest('li') as HTMLElement)

    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('renders due_date for each block', () => {
    render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', due_date: '2025-01-15' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('2025-01-15')).toBeInTheDocument()
  })

  it('a11y: no violations with destructive variant', async () => {
    const { container } = render(
      <AlertSection
        variant="destructive"
        title="Overdue"
        blocks={[makeBlock({ id: 'B1', todo_state: 'TODO', priority: '1', content: 'a11y block' })]}
        pageTitles={defaultTitles}
        showPriorityBadge
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('a11y: no violations with pending variant', async () => {
    const { container } = render(
      <AlertSection
        variant="pending"
        title="Upcoming"
        blocks={[makeBlock({ id: 'B1', todo_state: 'TODO', content: 'a11y block' })]}
        pageTitles={defaultTitles}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('a11y: no violations when empty', async () => {
    const { container } = render(
      <AlertSection variant="destructive" title="Overdue" blocks={[]} pageTitles={new Map()} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
