/**
 * Tests for AgendaResults component (#606).
 *
 * Validates:
 *  1. Renders block items with status icons, priority badges, content
 *  2. Shows due date chip when block has due_date
 *  3. Shows source page breadcrumb from pageTitles
 *  4. Click on item calls onNavigateToPage
 *  5. Empty state without filters shows "No dated tasks found"
 *  6. Empty state with filters shows "No blocks match" + clear button
 *  7. Load more button appears when hasMore=true
 *  8. A11y audit passes (axe)
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('lucide-react', () => ({
  Circle: (props: Record<string, unknown>) => <svg data-testid="icon-todo" {...props} />,
  Clock: (props: Record<string, unknown>) => <svg data-testid="icon-doing" {...props} />,
  CheckCircle2: (props: Record<string, unknown>) => <svg data-testid="icon-done" {...props} />,
  Loader2: (props: Record<string, unknown>) => <svg data-testid="loader-spinner" {...props} />,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}))

import type { BlockRow } from '../../lib/tauri'
import { AgendaResults, type AgendaResultsProps } from '../AgendaResults'

function makeBlock(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'B1',
    block_type: 'block',
    content: 'test block',
    parent_id: 'PAGE1',
    position: 0,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: 'TODO',
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  }
}

const noopFn = () => {}

function defaultProps(overrides: Partial<AgendaResultsProps> = {}): AgendaResultsProps {
  return {
    blocks: [],
    loading: false,
    hasMore: false,
    onLoadMore: noopFn,
    onNavigateToPage: undefined,
    hasActiveFilters: false,
    onClearFilters: noopFn,
    pageTitles: new Map(),
    ...overrides,
  }
}

describe('AgendaResults', () => {
  // 1. Renders block items with status icons, priority badges, content
  it('renders block items with status icons, priority badges, and content', () => {
    const blocks = [
      makeBlock({ id: 'B1', todo_state: 'TODO', priority: '1', content: 'Buy groceries' }),
      makeBlock({ id: 'B2', todo_state: 'DOING', priority: '2', content: 'Write report' }),
      makeBlock({ id: 'B3', todo_state: 'DONE', priority: '3', content: 'Ship feature' }),
    ]

    render(<AgendaResults {...defaultProps({ blocks })} />)

    // All three items are rendered
    expect(screen.getByText('Buy groceries')).toBeInTheDocument()
    expect(screen.getByText('Write report')).toBeInTheDocument()
    expect(screen.getByText('Ship feature')).toBeInTheDocument()

    // Status icons
    expect(screen.getAllByTestId('icon-todo').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('icon-doing')).toBeInTheDocument()
    expect(screen.getByTestId('icon-done')).toBeInTheDocument()

    // Priority badges
    expect(screen.getByText('P1')).toBeInTheDocument()
    expect(screen.getByText('P2')).toBeInTheDocument()
    expect(screen.getByText('P3')).toBeInTheDocument()
  })

  // 2. Shows due date chip when block has due_date
  it('shows due date chip when block has due_date', () => {
    const blocks = [
      makeBlock({ id: 'B1', content: 'Deadline task', due_date: '2025-04-15' }),
      makeBlock({ id: 'B2', content: 'No deadline' }),
    ]

    render(<AgendaResults {...defaultProps({ blocks })} />)

    // The due date should be formatted compactly ("Apr 15" same year, or "Apr 15, 2025")
    expect(screen.getByText(/Apr 15/)).toBeInTheDocument()

    // The no-deadline block should NOT have a date chip
    const noDueDateItem = screen.getByText('No deadline').closest('li')
    expect(noDueDateItem).not.toBeNull()
    expect(noDueDateItem?.querySelector('.agenda-results-due')).toBeNull()
  })

  // 3. Shows source page breadcrumb from pageTitles
  it('shows source page breadcrumb from pageTitles', () => {
    const blocks = [
      makeBlock({ id: 'B1', parent_id: 'PAGE1', content: 'Task A' }),
      makeBlock({ id: 'B2', parent_id: 'PAGE2', content: 'Task B' }),
    ]
    const pageTitles = new Map([
      ['PAGE1', 'Daily Notes'],
      ['PAGE2', 'Work Projects'],
    ])

    render(<AgendaResults {...defaultProps({ blocks, pageTitles })} />)

    expect(screen.getByText(/Daily Notes/)).toBeInTheDocument()
    expect(screen.getByText(/Work Projects/)).toBeInTheDocument()
  })

  // 3b. Shows "Untitled" when pageTitles has no entry
  it('shows "Untitled" breadcrumb when page title is not resolved', () => {
    const blocks = [makeBlock({ id: 'B1', parent_id: 'UNKNOWN', content: 'Orphan' })]

    render(<AgendaResults {...defaultProps({ blocks, pageTitles: new Map() })} />)

    expect(screen.getByText(/Untitled/)).toBeInTheDocument()
  })

  // 4. Click on item calls onNavigateToPage
  it('calls onNavigateToPage when an item is clicked', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()
    const blocks = [makeBlock({ id: 'B1', parent_id: 'PAGE1', content: 'Clickable task' })]
    const pageTitles = new Map([['PAGE1', 'My Page']])

    render(<AgendaResults {...defaultProps({ blocks, pageTitles, onNavigateToPage })} />)

    await user.click(screen.getByText('Clickable task'))

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE1', 'My Page', 'B1')
  })

  // 4b. Keyboard navigation (Enter)
  it('calls onNavigateToPage on Enter key', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()
    const blocks = [makeBlock({ id: 'B1', parent_id: 'PAGE1', content: 'Keyboard task' })]
    const pageTitles = new Map([['PAGE1', 'Page Title']])

    render(<AgendaResults {...defaultProps({ blocks, pageTitles, onNavigateToPage })} />)

    const item = screen.getByText('Keyboard task').closest('li')
    expect(item).not.toBeNull()
    item?.focus()
    await user.keyboard('{Enter}')

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE1', 'Page Title', 'B1')
  })

  // 5. Empty state without filters shows "No dated tasks found"
  it('shows "No dated tasks found" empty state when no filters active', () => {
    render(<AgendaResults {...defaultProps({ blocks: [], hasActiveFilters: false })} />)

    expect(
      screen.getByText(/No dated tasks found\. Add a due date or scheduled date/),
    ).toBeInTheDocument()
  })

  // 6. Empty state with filters shows "No blocks match" + clear button
  it('shows "No blocks match" + clear button when filters are active', async () => {
    const user = userEvent.setup()
    const onClearFilters = vi.fn()

    render(
      <AgendaResults {...defaultProps({ blocks: [], hasActiveFilters: true, onClearFilters })} />,
    )

    expect(screen.getByText(/No blocks match your filters\./)).toBeInTheDocument()

    const clearBtn = screen.getByRole('button', { name: /clear all filters/i })
    expect(clearBtn).toBeInTheDocument()

    await user.click(clearBtn)
    expect(onClearFilters).toHaveBeenCalledOnce()
  })

  // 7. Load more button appears when hasMore=true
  it('shows load more button when hasMore is true', async () => {
    const user = userEvent.setup()
    const onLoadMore = vi.fn()
    const blocks = [makeBlock({ id: 'B1', content: 'First batch' })]

    render(<AgendaResults {...defaultProps({ blocks, hasMore: true, onLoadMore })} />)

    const loadMoreBtn = screen.getByRole('button', { name: /load more tasks/i })
    expect(loadMoreBtn).toBeInTheDocument()

    await user.click(loadMoreBtn)
    expect(onLoadMore).toHaveBeenCalledOnce()
  })

  // 7b. Hides load more when hasMore=false
  it('hides load more button when hasMore is false', () => {
    const blocks = [makeBlock({ id: 'B1', content: 'Only batch' })]

    render(<AgendaResults {...defaultProps({ blocks, hasMore: false })} />)

    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  // 7c. Loading spinner on initial load
  it('shows loading spinner during initial load', () => {
    render(<AgendaResults {...defaultProps({ blocks: [], loading: true })} />)

    expect(screen.getByTestId('loader-spinner')).toBeInTheDocument()
    expect(screen.getByText('Loading tasks...')).toBeInTheDocument()
  })

  // 7d. Screen reader announces result count
  it('announces result count via role="status"', () => {
    const blocks = [
      makeBlock({ id: 'B1', content: 'Task 1' }),
      makeBlock({ id: 'B2', content: 'Task 2' }),
    ]

    render(<AgendaResults {...defaultProps({ blocks })} />)

    const statusRegion = screen.getByRole('status')
    expect(statusRegion).toHaveTextContent('2 results')
  })

  // 8. A11y audit passes (axe)
  it('a11y: no violations', async () => {
    const blocks = [
      makeBlock({
        id: 'B1',
        todo_state: 'TODO',
        priority: '1',
        content: 'accessible task',
        due_date: '2025-06-15',
      }),
      makeBlock({ id: 'B2', todo_state: 'DOING', content: 'in-progress task' }),
      makeBlock({ id: 'B3', todo_state: 'DONE', content: 'done task' }),
    ]
    const pageTitles = new Map([['PAGE1', 'Page Title']])

    const { container } = render(
      <AgendaResults {...defaultProps({ blocks, pageTitles, hasMore: true })} />,
    )

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // 9. Date group headers with groupBy=date
  it('renders date group headers when groupBy=date', () => {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const blocks = [
      makeBlock({ id: 'B1', due_date: todayStr, todo_state: 'TODO' }),
      makeBlock({ id: 'B2', due_date: '2020-01-01', todo_state: 'TODO' }),
    ]

    render(<AgendaResults {...defaultProps({ blocks })} groupBy="date" />)

    // Should see group headers
    expect(screen.getByText(/Overdue/)).toBeInTheDocument()
    expect(screen.getByText(/Today/)).toBeInTheDocument()
  })

  it('renders flat list when groupBy=none', () => {
    const blocks = [
      makeBlock({ id: 'B1', due_date: '2020-01-01', todo_state: 'TODO', content: 'Task A' }),
      makeBlock({ id: 'B2', due_date: '2025-12-01', todo_state: 'TODO', content: 'Task B' }),
    ]

    render(<AgendaResults {...defaultProps({ blocks })} groupBy="none" />)

    // Should NOT see group headers
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument()
    // Both tasks should be in the flat list
    expect(screen.getByText('Task A')).toBeInTheDocument()
    expect(screen.getByText('Task B')).toBeInTheDocument()
  })

  it('sorts blocks by date > state > priority even in flat mode', () => {
    const blocks = [
      makeBlock({ id: 'B2', due_date: '2025-06-20', todo_state: 'TODO', priority: '2', content: 'Later task' }),
      makeBlock({ id: 'B1', due_date: '2025-06-15', todo_state: 'TODO', priority: '1', content: 'Earlier task' }),
    ]

    render(<AgendaResults {...defaultProps({ blocks })} />)

    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Earlier task')
    expect(items[1]).toHaveTextContent('Later task')
  })

  it('renders priority group headers when groupBy is priority', () => {
    const blocks = [
      makeBlock({ id: 'B1', priority: '1', content: 'Urgent' }),
      makeBlock({ id: 'B2', priority: '2', content: 'Medium' }),
      makeBlock({ id: 'B3', priority: '3', content: 'Low' }),
      makeBlock({ id: 'B4', priority: null, content: 'None' }),
    ]

    const { container } = render(
      <AgendaResults {...defaultProps({ blocks })} groupBy="priority" />,
    )

    const headers = container.querySelectorAll('.agenda-group-header')
    const labels = [...headers].map((h) => h.textContent?.replace(/\(\d+\)/, '').trim())
    expect(labels).toEqual(['P1', 'P2', 'P3', 'No priority'])

    // Count badges
    const badges = screen.getAllByText('(1)')
    expect(badges.length).toBe(4)
  })

  it('renders state group headers when groupBy is state', () => {
    const blocks = [
      makeBlock({ id: 'B1', todo_state: 'DOING', content: 'In progress' }),
      makeBlock({ id: 'B2', todo_state: 'TODO', content: 'Pending' }),
      makeBlock({ id: 'B3', todo_state: 'DONE', content: 'Finished' }),
      makeBlock({ id: 'B4', todo_state: null, content: 'Unset' }),
    ]

    const { container } = render(
      <AgendaResults {...defaultProps({ blocks })} groupBy="state" />,
    )

    const headers = container.querySelectorAll('.agenda-group-header')
    const labels = [...headers].map((h) => h.textContent?.replace(/\(\d+\)/, '').trim())
    expect(labels).toEqual(['DOING', 'TODO', 'DONE', 'No state'])

    // Count badges
    const badges = screen.getAllByText('(1)')
    expect(badges.length).toBe(4)
  })

  // 12. sortBy="priority" sorts blocks by priority first
  it('sortBy="priority" sorts blocks by priority first', () => {
    const blocks = [
      makeBlock({ id: 'B1', priority: '3', due_date: '2025-06-10', content: 'Low prio' }),
      makeBlock({ id: 'B2', priority: '1', due_date: '2025-06-20', content: 'High prio' }),
    ]

    render(<AgendaResults {...defaultProps({ blocks })} groupBy="none" sortBy="priority" />)

    const items = screen.getAllByRole('listitem')
    // priority-first: P1 before P3, regardless of date
    expect(items[0]).toHaveTextContent('High prio')
    expect(items[1]).toHaveTextContent('Low prio')
  })

  // 13. sortBy="state" sorts blocks by state first
  it('sortBy="state" sorts blocks by state first', () => {
    const blocks = [
      makeBlock({ id: 'B1', todo_state: 'DONE', due_date: '2025-06-10', content: 'Finished task' }),
      makeBlock({ id: 'B2', todo_state: 'DOING', due_date: '2025-06-20', content: 'Active task' }),
      makeBlock({ id: 'B3', todo_state: 'TODO', due_date: '2025-06-15', content: 'Pending task' }),
    ]

    render(<AgendaResults {...defaultProps({ blocks })} groupBy="none" sortBy="state" />)

    const items = screen.getAllByRole('listitem')
    // state-first: DOING > TODO > DONE
    expect(items[0]).toHaveTextContent('Active task')
    expect(items[1]).toHaveTextContent('Pending task')
    expect(items[2]).toHaveTextContent('Finished task')
  })
})
