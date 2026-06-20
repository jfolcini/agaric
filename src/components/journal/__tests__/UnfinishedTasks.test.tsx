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
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makeBlock } from '../../../__tests__/fixtures'
import { logger } from '../../../lib/logger'
import type { BlockRow } from '../../../lib/tauri'
import { useSpaceStore } from '../../../stores/space'

// ── Helpers ─────────────────────────────────────────────────────────

const mockedInvoke = vi.mocked(invoke)

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
  return makeBlock({
    id,
    content,
    todo_state: 'TODO',
    due_date: daysAgo(1),
    parent_id: 'PAGE_1',
    page_id: 'PAGE_1',
  })
}

function makeThisWeekBlock(id = 'W1', content = 'This week task'): BlockRow {
  return makeBlock({
    id,
    content,
    todo_state: 'DOING',
    due_date: daysAgo(3),
    parent_id: 'PAGE_1',
    page_id: 'PAGE_1',
  })
}

function makeOlderBlock(id = 'O1', content = 'Older task'): BlockRow {
  return makeBlock({
    id,
    content,
    todo_state: 'TODO',
    due_date: daysAgo(14),
    priority: '1',
    parent_id: 'PAGE_1',
    page_id: 'PAGE_1',
  })
}

// ── Mock setup ──────────────────────────────────────────────────────

/**
 * Set up invoke mock to return blocks for queryByProperty calls
 * and resolved pages for batchResolve.
 */
function mockInvokeForBlocks(blocks: BlockRow[], resolvedPages?: { id: string; title: string }[]) {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'list_unfinished_tasks') {
      const params = args as { beforeDate: string; todoStates: string[] }
      const beforeDate = params.beforeDate
      const todoStates = params.todoStates
      const filtered = blocks.filter((b) => {
        if (!todoStates.includes(b.todo_state ?? '')) return false
        const date = b.due_date ?? b.scheduled_date
        if (!date || date >= beforeDate) return false
        return true
      })
      return { items: filtered, next_cursor: null, has_more: false }
    }
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
    return { items: [], next_cursor: null, has_more: false, total_count: null }
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

  // #1520 — UnfinishedTasks has NO roving model and does NOT pass `isFocused`
  // to BlockListItem. Making rows roving must NOT strand keyboard users here:
  // with `isFocused` absent every BlockListItem row stays tab-reachable
  // (tabIndex=0).
  it('keeps every row tab-reachable (tabIndex=0) — no roving model here (#1520)', async () => {
    const blocks = [makeYesterdayBlock('Y1', 'task a'), makeYesterdayBlock('Y2', 'task b')]
    mockInvokeForBlocks(blocks, [{ id: 'PAGE_1', title: 'Test Page' }])

    render(<UnfinishedTasks />)

    await waitFor(() => {
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
    })

    const expandBtn = screen.getByRole('button', { expanded: false })
    await userEvent.setup().click(expandBtn)

    const rows = screen.getAllByRole('listitem')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).toHaveAttribute('tabindex', '0')
    }
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

  // #757 — listUnfinishedTasks is cursor-paginated (200-row pages capped by
  // PageRequest::new). The component previously ignored has_more/next_cursor,
  // silently undercounting the badge and the Older group past one page.
  describe('cursor pagination (#757)', () => {
    it('drains has_more pages: badge and groups count tasks from every page', async () => {
      const pageOne = [
        makeYesterdayBlock('PG1-A', 'First page task A'),
        makeYesterdayBlock('PG1-B', 'First page task B'),
        makeOlderBlock('PG1-C', 'First page older task'),
      ]
      const pageTwo = [
        makeBlock({
          id: 'PG2-A',
          content: 'Second page older task',
          todo_state: 'TODO',
          due_date: daysAgo(30),
          page_id: null,
        }),
      ]

      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_unfinished_tasks') {
          const params = args as { cursor?: string | null }
          if (params.cursor == null) {
            return { items: pageOne, next_cursor: 'CURSOR-1', has_more: true }
          }
          return { items: pageTwo, next_cursor: null, has_more: false }
        }
        if (cmd === 'batch_resolve') return []
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      })

      const user = userEvent.setup()
      const { container } = render(<UnfinishedTasks />)

      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })

      // Badge counts ALL pages: 3 + 1 = 4 (pre-#757 it showed 3).
      expect(screen.getByText('4')).toBeInTheDocument()

      // Exactly two IPC pages, the second continuing the cursor chain.
      const calls = mockedInvoke.mock.calls.filter((c) => c[0] === 'list_unfinished_tasks')
      expect(calls).toHaveLength(2)
      const cursors = calls.map((c) => (c[1] as { cursor?: string | null }).cursor)
      expect(cursors).toEqual([null, 'CURSOR-1'])

      // The second-page task renders in the Older group alongside page 1's.
      await user.click(screen.getByRole('button', { expanded: false }))
      const olderGroup = screen.getByTestId('unfinished-group-older')
      expect(within(olderGroup).getByText('First page older task')).toBeInTheDocument()
      expect(within(olderGroup).getByText('Second page older task')).toBeInTheDocument()

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    it('stops the drain at the page cap when the backend always reports more', async () => {
      let page = 0
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_unfinished_tasks') {
          page += 1
          return {
            items: [
              makeBlock({
                id: `RUNAWAY-${page}`,
                content: `Runaway task ${page}`,
                todo_state: 'TODO',
                due_date: daysAgo(14),
                page_id: null,
              }),
            ],
            // Non-advancing backend bug scenario: always claims more.
            next_cursor: `C-${page}`,
            has_more: true,
          }
        }
        if (cmd === 'batch_resolve') return []
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      })

      render(<UnfinishedTasks />)

      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })

      // MAX_UNFINISHED_PAGES (25) bounds the loop instead of spinning forever.
      const calls = mockedInvoke.mock.calls.filter((c) => c[0] === 'list_unfinished_tasks')
      expect(calls).toHaveLength(25)
      expect(screen.getAllByText('25').length).toBeGreaterThanOrEqual(1)
    })
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
    const yesterdayHeader = within(yesterdayGroup).getByRole('button', {
      expanded: true,
    })
    await user.click(yesterdayHeader)

    // Yesterday items should be hidden, older should still be visible
    expect(within(yesterdayGroup).queryByText('Yesterday task')).not.toBeInTheDocument()
    expect(within(olderGroup).getByText('Older task')).toBeInTheDocument()
  })

  // Per-group collapse state persists to localStorage
  describe('per-group collapse persistence', () => {
    const STORAGE_KEY = 'agaric:unfinishedTasks.groupCollapsed'

    it('writes per-group collapse state to localStorage on toggle', async () => {
      const user = userEvent.setup()
      const blocks = [makeYesterdayBlock(), makeOlderBlock()]
      mockInvokeForBlocks(blocks)

      render(<UnfinishedTasks />)

      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })

      // Expand main section
      await user.click(screen.getByRole('button', { expanded: false }))

      // Collapse the yesterday group
      const yesterdayGroup = screen.getByTestId('unfinished-group-yesterday')
      const yesterdayHeader = within(yesterdayGroup).getByRole('button', {
        expanded: true,
      })
      await user.click(yesterdayHeader)

      // Storage now has the per-group state
      const stored = localStorage.getItem(STORAGE_KEY)
      expect(stored).not.toBeNull()
      const parsed = JSON.parse(stored as string)
      expect(parsed).toEqual({ yesterday: true })
    })

    it('round-trip: state survives an unmount + remount', async () => {
      const user = userEvent.setup()
      const blocks = [makeYesterdayBlock(), makeOlderBlock()]
      mockInvokeForBlocks(blocks)

      // Pre-seed the main-section storage to "expanded" so the second mount
      // skips the expand click and exposes only the per-group state we care
      // about. (`writeGroupCollapsedState` is the unit under test here.)
      localStorage.setItem('unfinishedTasks.collapsed', 'false')

      const { unmount } = render(<UnfinishedTasks />)

      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })

      // Section is already expanded — collapse the yesterday group directly.
      const yesterdayGroup = screen.getByTestId('unfinished-group-yesterday')
      const yesterdayHeader = within(yesterdayGroup).getByRole('button', {
        expanded: true,
      })
      await user.click(yesterdayHeader)

      // Storage round-trip check
      const stored = localStorage.getItem(STORAGE_KEY)
      expect(stored).not.toBeNull()
      expect(JSON.parse(stored as string)).toEqual({ yesterday: true })

      // Unmount + re-mount fresh (the new render re-reads localStorage).
      unmount()
      mockInvokeForBlocks(blocks)
      render(<UnfinishedTasks />)

      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })

      // Yesterday should be collapsed (expanded=false), older expanded.
      const yesterdayGroupB = screen.getByTestId('unfinished-group-yesterday')
      const olderGroupB = screen.getByTestId('unfinished-group-older')
      expect(within(yesterdayGroupB).getByRole('button', { expanded: false })).toBeInTheDocument()
      expect(within(olderGroupB).getByRole('button', { expanded: true })).toBeInTheDocument()
    })

    it('tolerates corrupted JSON without crashing', async () => {
      localStorage.setItem(STORAGE_KEY, '{not-json')
      mockInvokeForBlocks([makeYesterdayBlock()])

      render(<UnfinishedTasks />)

      // Should still render normally (default groupCollapsed = {})
      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })
    })

    it('tolerates a non-object stored value', async () => {
      localStorage.setItem(STORAGE_KEY, '"not-an-object"')
      mockInvokeForBlocks([makeYesterdayBlock()])

      render(<UnfinishedTasks />)

      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })
    })

    it('drops non-boolean values from stored JSON', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          yesterday: true,
          thisWeek: 'collapsed',
          older: false,
        }),
      )
      const user = userEvent.setup()
      mockInvokeForBlocks([makeYesterdayBlock(), makeThisWeekBlock(), makeOlderBlock()])

      render(<UnfinishedTasks />)

      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { expanded: false }))

      // yesterday => true (collapsed), thisWeek => dropped (default expanded), older => false (expanded)
      expect(
        within(screen.getByTestId('unfinished-group-yesterday')).getByRole('button', {
          expanded: false,
        }),
      ).toBeInTheDocument()
      expect(
        within(screen.getByTestId('unfinished-group-thisWeek')).getByRole('button', {
          expanded: true,
        }),
      ).toBeInTheDocument()
      expect(
        within(screen.getByTestId('unfinished-group-older')).getByRole('button', {
          expanded: true,
        }),
      ).toBeInTheDocument()
    })
  })

  // --- Error paths ---
  describe('error paths', () => {
    it('listUnfinishedTasks rejects — shows empty state and logs warning', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_unfinished_tasks') {
          throw new Error('query failure')
        }
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      })

      const { container } = render(<UnfinishedTasks />)

      // Wait for loading to finish
      await waitFor(() => {
        expect(screen.queryByRole('status', { busy: true })).not.toBeInTheDocument()
      })

      // Component shows empty state (no crash, no blocks rendered)
      expect(screen.queryByTestId('unfinished-tasks')).not.toBeInTheDocument()
      expect(container.innerHTML).toBe('')

      expect(warnSpy).toHaveBeenCalledWith(
        'UnfinishedTasks',
        'fetchUnfinished failed',
        undefined,
        expect.any(Error),
      )
      warnSpy.mockRestore()
    })

    // #826 — the fetch `.catch` previously called setBlocks([]) unconditionally.
    // A slow rejection from a superseded effect run must NOT clobber the newer
    // run's successfully-loaded data (same stale-guard contract as #757). The
    // effect re-runs when currentSpaceId changes, so we drive two runs: run #1
    // rejects slowly, run #2 loads good data, then run #1's stale rejection
    // arrives last and must be ignored.
    it('#826 — a stale rejection does not clobber a newer run’s loaded data', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      // Run #1 (space SPACE_A) hangs until we reject it after run #2 has loaded.
      let rejectRun1: (err: Error) => void = () => {}
      const run1 = new Promise<never>((_resolve, reject) => {
        rejectRun1 = reject
      })
      let callIndex = 0
      const goodBlocks = [makeYesterdayBlock('NEW', 'Fresh task from run 2')]
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_unfinished_tasks') {
          callIndex += 1
          // First effect run rejects (slowly); the second resolves with data.
          if (callIndex === 1) return run1
          return { items: goodBlocks, next_cursor: null, has_more: false }
        }
        if (cmd === 'batch_resolve') return []
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      })

      useSpaceStore.setState({ currentSpaceId: 'SPACE_A' })
      render(<UnfinishedTasks />)

      // Run #1 is in flight → loading skeleton shows.
      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks-loading')).toBeInTheDocument()
      })

      // Switch space → effect cleanup marks run #1 stale and run #2 starts.
      await act(async () => {
        useSpaceStore.setState({ currentSpaceId: 'SPACE_B' })
      })

      // Run #2's data is rendered.
      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { expanded: false }))
      expect(screen.getByText('Fresh task from run 2')).toBeInTheDocument()

      // NOW the stale run #1 rejects. Without the guard its catch would call
      // setBlocks([]) and wipe run #2's data, hiding the whole section.
      await act(async () => {
        rejectRun1(new Error('stale rejection from superseded run'))
        await run1.catch(() => {})
      })

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          'UnfinishedTasks',
          'fetchUnfinished failed',
          undefined,
          expect.any(Error),
        )
      })

      // The newer run's data survives — the stale rejection did not clobber it.
      expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      expect(screen.getByText('Fresh task from run 2')).toBeInTheDocument()

      warnSpy.mockRestore()
      useSpaceStore.setState({ currentSpaceId: null })
    })

    it('batchResolve rejects — blocks render without page titles', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'list_unfinished_tasks') {
          const params = args as { beforeDate: string; todoStates: string[] }
          const beforeDate = params.beforeDate
          const todoStates = params.todoStates
          const blocks = [makeYesterdayBlock()]
          const filtered = blocks.filter((b) => {
            if (!todoStates.includes(b.todo_state ?? '')) return false
            const date = b.due_date ?? b.scheduled_date
            if (!date || date >= beforeDate) return false
            return true
          })
          return { items: filtered, next_cursor: null, has_more: false }
        }
        if (cmd === 'query_by_property') {
          const params = args as { key: string }
          const key = params.key
          const blocks = [makeYesterdayBlock()]
          const filtered = blocks.filter((b) => {
            if (key === 'due_date') return b.due_date != null
            if (key === 'scheduled_date') return b.scheduled_date != null
            return false
          })
          return { items: filtered, next_cursor: null, has_more: false }
        }
        if (cmd === 'batch_resolve') {
          throw new Error('resolve failure')
        }
        return { items: [], next_cursor: null, has_more: false, total_count: null }
      })

      render(<UnfinishedTasks />)

      // Wait for component to render with blocks
      await waitFor(() => {
        expect(screen.getByTestId('unfinished-tasks')).toBeInTheDocument()
      })

      // Expand the section (collapsed by default)
      await user.click(screen.getByRole('button', { expanded: false }))

      // Block content should still appear even though title resolution failed
      expect(screen.getByText('Yesterday task')).toBeInTheDocument()

      // Page title falls back to 'Untitled' since batchResolve failed
      expect(screen.getByText(/Untitled/)).toBeInTheDocument()
    })
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
