/**
 * Tests for OverdueSection component.
 *
 * Validates:
 *  - Renders overdue blocks with count badge
 *  - Returns null for empty blocks
 *  - Shows todo_state badge
 *  - Shows priority badge
 *  - Sorts blocks by due_date
 *  - Navigation on click
 *  - Navigation on keyboard (Enter)
 *  - Renders due_date for each block
 *  - a11y audit passes (axe)
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { BlockRow } from '../../lib/tauri'
import { OverdueSection } from '../OverdueSection'

function makeBlock(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'B1',
    block_type: 'block',
    content: 'overdue block',
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

describe('OverdueSection', () => {
  const defaultTitles = new Map([['PAGE1', 'My Page']])

  it('renders overdue title and count badge', () => {
    const blocks = [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2', content: 'second' })]

    render(<OverdueSection blocks={blocks} pageTitles={defaultTitles} />)

    expect(screen.getByText('Overdue')).toBeInTheDocument()
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('returns null when blocks array is empty', () => {
    const { container } = render(<OverdueSection blocks={[]} pageTitles={new Map()} />)

    expect(container.innerHTML).toBe('')
  })

  it('shows todo_state badge when present', () => {
    render(
      <OverdueSection
        blocks={[makeBlock({ id: 'B1', todo_state: 'TODO' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('TODO')).toBeInTheDocument()
  })

  it('shows priority badge when present', () => {
    render(
      <OverdueSection
        blocks={[makeBlock({ id: 'B1', priority: '1' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('P1')).toBeInTheDocument()
  })

  it('does not show priority badge when null', () => {
    render(
      <OverdueSection
        blocks={[makeBlock({ id: 'B1', priority: null })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.queryByText(/^P\d$/)).not.toBeInTheDocument()
  })

  it('sorts blocks by due_date ascending', () => {
    const blocks = [
      makeBlock({ id: 'B1', content: 'later', due_date: '2025-03-01' }),
      makeBlock({ id: 'B2', content: 'earlier', due_date: '2025-01-15' }),
      makeBlock({ id: 'B3', content: 'middle', due_date: '2025-02-01' }),
    ]

    render(<OverdueSection blocks={blocks} pageTitles={defaultTitles} />)

    const items = screen.getAllByText(/earlier|middle|later/)
    expect(items[0]).toHaveTextContent('earlier')
    expect(items[1]).toHaveTextContent('middle')
    expect(items[2]).toHaveTextContent('later')
  })

  it('navigates to parent page on click', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <OverdueSection
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
      <OverdueSection
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

  it('renders due_date for each block', () => {
    render(
      <OverdueSection
        blocks={[makeBlock({ id: 'B1', due_date: '2025-01-15' })]}
        pageTitles={defaultTitles}
      />,
    )

    expect(screen.getByText('2025-01-15')).toBeInTheDocument()
  })

  it('does not navigate when parent_id is null', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()

    render(
      <OverdueSection
        blocks={[makeBlock({ id: 'B1', parent_id: null, content: 'orphan' })]}
        pageTitles={new Map()}
        onNavigateToPage={onNavigate}
      />,
    )

    const item = screen.getByText('orphan')
    await user.click(item.closest('li') as HTMLElement)

    expect(onNavigate).not.toHaveBeenCalled()
  })

  describe('overdue label', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-06-15T12:00:00'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('displays days overdue for overdue blocks', () => {
      render(
        <OverdueSection
          blocks={[makeBlock({ id: 'B1', due_date: '2025-06-08' })]}
          pageTitles={defaultTitles}
        />,
      )

      expect(screen.getByText('2025-06-08')).toBeInTheDocument()
      expect(screen.getByText('(7d overdue)')).toBeInTheDocument()
    })

    it("does not show overdue label for today's due date", () => {
      render(
        <OverdueSection
          blocks={[makeBlock({ id: 'B1', due_date: '2025-06-15' })]}
          pageTitles={defaultTitles}
        />,
      )

      expect(screen.getByText('2025-06-15')).toBeInTheDocument()
      expect(screen.queryByText(/\d+d overdue/)).not.toBeInTheDocument()
    })
  })

  it('a11y: no violations', async () => {
    const { container } = render(
      <OverdueSection
        blocks={[makeBlock({ id: 'B1', todo_state: 'TODO', priority: '1', content: 'a11y block' })]}
        pageTitles={defaultTitles}
      />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('a11y: no violations when empty', async () => {
    const { container } = render(<OverdueSection blocks={[]} pageTitles={new Map()} />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
