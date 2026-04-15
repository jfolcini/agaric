/**
 * Tests for UnfinishedTasks component (F-23).
 *
 * Validates:
 *  1. Renders unfinished tasks grouped by age (Yesterday, This Week, Older)
 *  2. Groups with no items are hidden
 *  3. Collapsed by default
 *  4. Click expands/collapses
 *  5. Click item navigates to page
 *  6. Empty state when no unfinished tasks
 *  7. Only shows for today's date (tested via DailyView integration)
 *  8. axe a11y audit
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { BlockRow } from '../../../lib/tauri'

// ── Helpers ─────────────────────────────────────────────────────────

const mockedInvoke = vi.mocked(invoke)

function makeBlock(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: 'B1',
    block_type: 'content',
    content: 'Test task',
    parent_id: 'PAGE_1',
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: 'TODO',
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: 'PAGE_1',
    ...overrides,
  }
}

/** Format a Date as YYYY-MM-DD in local time (matches component's toLocalDateStr). */
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Returns YYYY-MM-DD for today in local time. */
function todayStr(): string {
  return toLocalDateStr(new Date())
}

/** Returns YYYY-MM-DD for N days ago in local time. */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toLocalDateStr(d)
}

// Build test blocks with dates relative to today
function makeYesterdayBlock(id = 'Y1', content = 'Yesterday task'): BlockRow {
  return makeBlock({ id, content, todo_state: 'TODO', due_date: daysAgo(1) })
}

function makeThisWeekBlock(id = 'W1', content = 'This week task'): BlockRow {
  return makeBlock({ id, content, todo_state: 'DOING', due_date: daysAgo(3) })
}

function makeOlderBlock(id = 'O1', content = 'Older task'): BlockRow {
  return makeBlock({ id, content, todo_state: 'TODO', due_date: daysAgo(14), priority: '1' })
}

// ── Mock setup ──────────────────────────────────────────────────────

/**
 * Set up invoke mock to return blocks for queryByProperty calls
 * and resolved pages for batchResolve.
 */
function mockInvokeForBlocks(blocks: BlockRow[], resolvedPages?: { id: string; title: string }[]) {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'query_by_property') {
      const params = args as { key: string }
      const key = params.key
      // Return blocks that have the queried property set
      const filtered = blocks.filter((b) => {
        if (key === 'due_date') return b.due_date != null
        if (key === 'scheduled_date') return b.scheduled_date != null
        return false
      })
      return { items: filtered, next_cursor: null, has_more: false }
    }
    if (cmd === 'batch_resolve') {
      return (resolvedPages ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        block_type: 'page',
        deleted: false,
      }))
    }
    return { items: [], next_cursor: null, has_more: false }
  })
}

import { UnfinishedTasks } from '../UnfinishedTasks'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

// ── Tests ────────────────────────────────────────────────────────────

describe('UnfinishedTasks', () => {
  it('renders nothing when no unfinished tasks', async () => {
    mockInvokeForBlocks([])

    const { container } = render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.queryByTestId('unfinished-tasks')).not.toBeInTheDocument()
      expect(screen.queryByRole('status', { busy: true })).not.toBeInTheDocument()
    })
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when all tasks are DONE', async () => {
    const doneBlock = makeBlock({
      id: 'D1',
      todo_state: 'DONE',
      due_date: daysAgo(2),
    })
    mockInvokeForBlocks([doneBlock])

    const { container } = render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.queryByTestId('unfinished-tasks')).not.toBeInTheDocument()
      expect(screen.queryByRole('status', { busy: true })).not.toBeInTheDocument()
    })
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when all dates are today or future', async () => {
    const futureBlock = makeBlock({
      id: 'F1',
      todo_state: 'TODO',
      due_date: todayStr(),
    })
    mockInvokeForBlocks([futureBlock])

    const { container } = render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.queryByTestId('unfinished-tasks')).not.toBeInTheDocument()
      expect(screen.queryByRole('status', { busy: true })).not.toBeInTheDocument()
    })
    expect(container.innerHTML).toBe('')
  })

  it('renders unfinished tasks grouped by age', async () => {
    const blocks = [makeYesterdayBlock(), makeThisWeekBlock(), makeOlderBlock()]
    mockInvokeForBlocks(blocks, [{ id: 'PAGE_1', title: 'Test Page' }])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    // Section is collapsed by default — expand it
    const expandBtn = screen.getByRole('button', { expanded: false })
    await userEvent.setup().click(expandBtn)

    // All three groups should be visible
    expect(screen.getByTestId('unfinished-group-yesterday')).toBeInTheDocument()
    expect(screen.getByTestId('unfinished-group-thisWeek')).toBeInTheDocument()
    expect(screen.getByTestId('unfinished-group-older')).toBeInTheDocument()
  })

  it('hides groups with no items', async () => {
    // Only yesterday block
    const blocks = [makeYesterdayBlock()]
    mockInvokeForBlocks(blocks)

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    // Expand
    const expandBtn = screen.getByRole('button', { expanded: false })
    await userEvent.setup().click(expandBtn)

    expect(screen.getByTestId('unfinished-group-yesterday')).toBeInTheDocument()
    expect(screen.queryByTestId('unfinished-group-thisWeek')).not.toBeInTheDocument()
    expect(screen.queryByTestId('unfinished-group-older')).not.toBeInTheDocument()
  })

  it('starts collapsed by default', async () => {
    mockInvokeForBlocks([makeYesterdayBlock()])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    // The main header should have aria-expanded=false
    const header = screen.getByRole('button', { expanded: false })
    expect(header).toBeInTheDocument()

    // Groups should not be visible when collapsed
    expect(screen.queryByTestId('unfinished-group-yesterday')).not.toBeInTheDocument()
  })

  it('expands and collapses on click', async () => {
    const user = userEvent.setup()
    mockInvokeForBlocks([makeYesterdayBlock()])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    // Initially collapsed
    expect(screen.queryByTestId('unfinished-group-yesterday')).not.toBeInTheDocument()

    // Click to expand — target the main header by its text
    const header = screen.getByText('Unfinished Tasks').closest('button') as Element
    await user.click(header)

    expect(screen.getByTestId('unfinished-group-yesterday')).toBeInTheDocument()

    // Click again to collapse
    await user.click(header)

    expect(screen.queryByTestId('unfinished-group-yesterday')).not.toBeInTheDocument()
  })

  it('persists collapsed state in localStorage', async () => {
    const user = userEvent.setup()
    mockInvokeForBlocks([makeYesterdayBlock()])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    const header = screen.getByText('Unfinished Tasks').closest('button') as Element

    // Expand
    await user.click(header)

    expect(localStorage.getItem('unfinishedTasks.collapsed')).toBe('false')

    // Collapse
    await user.click(header)

    expect(localStorage.getItem('unfinishedTasks.collapsed')).toBe('true')
  })

  it('shows count badge with total number of tasks', async () => {
    const blocks = [
      makeYesterdayBlock('Y1'),
      makeYesterdayBlock('Y2', 'Another yesterday task'),
      makeOlderBlock(),
    ]
    mockInvokeForBlocks(blocks)

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    // Total badge should show 3
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('clicking an item navigates to page', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()
    mockInvokeForBlocks([makeYesterdayBlock()], [{ id: 'PAGE_1', title: 'My Page' }])

    render(<UnfinishedTasks onNavigateToPage={onNavigateToPage} />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    // Expand section
    await user.click(screen.getByRole('button', { expanded: false }))

    // Click the task item
    const item = screen.getByText('Yesterday task')
    await user.click(item.closest('li') as Element)

    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'My Page', 'Y1')
  })

  it('shows priority badge when block has priority', async () => {
    const user = userEvent.setup()
    mockInvokeForBlocks([makeOlderBlock()])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    // Expand
    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByText('P1')).toBeInTheDocument()
  })

  it('shows DOING icon for DOING tasks', async () => {
    const user = userEvent.setup()
    mockInvokeForBlocks([makeThisWeekBlock()])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByTestId('icon-doing')).toBeInTheDocument()
  })

  it('shows TODO icon for TODO tasks', async () => {
    const user = userEvent.setup()
    mockInvokeForBlocks([makeYesterdayBlock()])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByTestId('icon-todo')).toBeInTheDocument()
  })

  it('shows due date chip on items', async () => {
    const user = userEvent.setup()
    const yesterdayDate = daysAgo(1)
    mockInvokeForBlocks([makeYesterdayBlock()])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { expanded: false }))

    // The date chip should be present (formatted compactly)
    const dateStr = yesterdayDate
    const parts = dateStr.split('-')
    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]
    const month = monthNames[Number(parts[1]) - 1]
    const day = Number(parts[2])
    const expectedDate = `${month} ${day}`
    expect(screen.getByText(expectedDate)).toBeInTheDocument()
  })

  it('groups can be individually collapsed', async () => {
    const user = userEvent.setup()
    const blocks = [makeYesterdayBlock(), makeOlderBlock()]
    mockInvokeForBlocks(blocks)

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    // Expand main section
    await user.click(screen.getByRole('button', { expanded: false }))

    // Both groups should be visible and expanded
    const yesterdayGroup = screen.getByTestId('unfinished-group-yesterday')
    const olderGroup = screen.getByTestId('unfinished-group-older')

    expect(within(yesterdayGroup).getByText('Yesterday task')).toBeInTheDocument()
    expect(within(olderGroup).getByText('Older task')).toBeInTheDocument()

    // Collapse the yesterday group
    const yesterdayHeader = within(yesterdayGroup).getByRole('button', { expanded: true })
    await user.click(yesterdayHeader)

    // Yesterday items should be hidden, older should still be visible
    expect(within(yesterdayGroup).queryByText('Yesterday task')).not.toBeInTheDocument()
    expect(within(olderGroup).getByText('Older task')).toBeInTheDocument()
  })

  it('handles scheduled_date blocks (not just due_date)', async () => {
    const user = userEvent.setup()
    const block = makeBlock({
      id: 'S1',
      content: 'Scheduled task',
      todo_state: 'TODO',
      due_date: null,
      scheduled_date: daysAgo(2),
      page_id: null,
    })
    mockInvokeForBlocks([block])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByText('Scheduled task')).toBeInTheDocument()
  })

  it('has no a11y violations when empty', async () => {
    mockInvokeForBlocks([])

    const { container } = render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.queryByRole('status', { busy: true })).not.toBeInTheDocument()
    })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when expanded with tasks', async () => {
    const user = userEvent.setup()
    mockInvokeForBlocks([makeYesterdayBlock(), makeOlderBlock()])

    const { container } = render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    // Expand
    await user.click(screen.getByRole('button', { expanded: false }))

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

// ── DailyView integration tests ──────────────────────────────────────

// Mock DaySection — vi.mock is hoisted above imports automatically
vi.mock('../DaySection', () => ({
  DaySection: (props: Record<string, unknown>) => {
    const entry = props['entry'] as { dateStr: string; displayDate: string }
    return (
      <section data-testid="day-section" data-date={entry.dateStr}>
        <span>{entry.displayDate}</span>
      </section>
    )
  },
}))

// Import DailyView after vi.mock (hoisting ensures mocks apply)
import { DailyView } from '../DailyView'

describe('UnfinishedTasks in DailyView', () => {
  it("shows UnfinishedTasks only for today's date", async () => {
    const today = new Date()
    const entry = {
      date: today,
      dateStr: todayStr(),
      displayDate: 'Today',
      pageId: 'P1',
    }

    mockInvokeForBlocks([makeYesterdayBlock()])

    render(<DailyView entry={entry} onAddBlock={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })
  })

  it('does not show UnfinishedTasks for past dates', async () => {
    const past = new Date()
    past.setDate(past.getDate() - 5)
    const entry = {
      date: past,
      dateStr: daysAgo(5),
      displayDate: 'Past Date',
      pageId: 'P2',
    }

    mockInvokeForBlocks([makeYesterdayBlock()])

    render(<DailyView entry={entry} onAddBlock={vi.fn()} />)

    // Wait for render to settle
    await waitFor(() => {
      expect(screen.getByTestId('day-section')).toBeInTheDocument()
    })

    // UnfinishedTasks should not be present
    expect(screen.queryByTestId('unfinished-tasks')).not.toBeInTheDocument()
    expect(screen.queryByTestId('unfinished-empty')).not.toBeInTheDocument()
  })

  it('does not show UnfinishedTasks for future dates', async () => {
    const future = new Date()
    future.setDate(future.getDate() + 3)
    const futureStr = future.toISOString().slice(0, 10)
    const entry = {
      date: future,
      dateStr: futureStr,
      displayDate: 'Future Date',
      pageId: 'P3',
    }

    mockInvokeForBlocks([makeYesterdayBlock()])

    render(<DailyView entry={entry} onAddBlock={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('day-section')).toBeInTheDocument()
    })

    expect(screen.queryByTestId('unfinished-tasks')).not.toBeInTheDocument()
    expect(screen.queryByTestId('unfinished-empty')).not.toBeInTheDocument()
  })
})
