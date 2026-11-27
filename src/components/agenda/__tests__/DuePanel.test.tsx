/**
 * Tests for DuePanel component (#600).
 *
 * Validates:
 *  1. The header names the panel, with no counts; today's tabs carry them
 *  2. Returns null / does not render when no items
 *  3. Another day's tasks are one flat list
 *  4. Sorts by date, then priority (1 > 2 > 3 > null)
 *  5. Shows loading spinner during fetch
 *  6. Shows source page breadcrumb from batchResolve
 *  7. Click navigates to source page
 *  8. Shows priority badge (P1/P2/P3)
 *  9. "Load more" button when hasMore=true
 *  10. Collapse/expand toggle works
 *  11. Re-fetches on date prop change
 *  12. A11y audit passes (axe)
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { clearProjectedCache } from '@/hooks/useDuePanelData'
import { t } from '@/lib/i18n'

// #4412 — `listBlocks` / `batchResolve` / `queryByProperty` retired their
// hand-written wrappers; the hook calls `commands.*` and unwraps the `Result`
// envelope, so the spies resolve raw data and the mock wraps it.
const { mockedListBlocks, mockedBatchResolve, mockedQueryByProperty, mockedListProjectedAgenda } =
  vi.hoisted(() => ({
    mockedListBlocks: vi.fn(),
    mockedBatchResolve: vi.fn(),
    mockedQueryByProperty: vi.fn(),
    mockedListProjectedAgenda: vi.fn(),
  }))
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      // Opening a page stamps it for the Pages view's "Last opened" sort (#5371).
      recordPageOpen: () => Promise.resolve({ status: 'ok', data: null }),
      listBlocks: (...args: unknown[]) =>
        mockedListBlocks(...args).then((data: unknown) => ({ status: 'ok', data })),
      batchResolve: (...args: unknown[]) =>
        mockedBatchResolve(...args).then((data: unknown) => ({ status: 'ok', data })),
      queryByProperty: (...args: unknown[]) =>
        mockedQueryByProperty(...args).then((data: unknown) => ({ status: 'ok', data })),
      listProjectedAgenda: (...args: unknown[]) =>
        mockedListProjectedAgenda(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

vi.mock('@/components/RichContentRenderer', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

vi.mock('@/hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

vi.mock('lucide-react', () => ({
  ChevronRight: (props: Record<string, unknown>) => <svg data-testid="chevron-right" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <svg data-testid="chevron-down" {...props} />,
  CheckCircle2: (props: Record<string, unknown>) => <svg data-testid="check-circle" {...props} />,
  Loader2: (props: Record<string, unknown>) => <svg data-testid="loader-spinner" {...props} />,
  CalendarDays: (props: Record<string, unknown>) => <svg data-testid="calendar-days" {...props} />,
  CalendarClock: (props: Record<string, unknown>) => (
    <svg data-testid="calendar-clock" {...props} />
  ),
  Flag: (props: Record<string, unknown>) => <svg data-testid="flag" {...props} />,
  Repeat: (props: Record<string, unknown>) => <svg data-testid="repeat-icon" {...props} />,
  Check: (props: Record<string, unknown>) => <svg data-testid="check-icon" {...props} />,
  Info: (props: Record<string, unknown>) => <svg data-testid="info-icon" {...props} />,
  X: (props: Record<string, unknown>) => <svg data-testid="x-icon" {...props} />,
}))

vi.mock('@/components/ui/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/button')>()
  return {
    ...actual,
    Button: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
  }
})

import { toast } from 'sonner'

import { makeBlock } from '@/__tests__/fixtures'
import { seedAgendaListBlocks } from '@/__tests__/mocks/agenda-list-blocks'
import { DuePanel } from '@/components/agenda/DuePanel'
import { useNavigationStore } from '@/stores/navigation'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

const mockedToastError = vi.mocked(toast.error)

const emptyResponse = {
  items: [],
  next_cursor: null,
  has_more: false,
  total_count: null,
}

/** The journal day every agenda assertion in this file renders. */
const DATE = '2025-06-15'

beforeEach(() => {
  vi.clearAllMocks()
  clearProjectedCache()
  // #2248 — the agenda fetch (`listBlocksForAgenda`) requires an active space
  // and short-circuits to empty otherwise; seed one so `listBlocks` runs.
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  // Titles a test resolves are written back to the shared cache.
  useResolveStore.setState({ cache: new Map(), version: 0 })
  mockedListBlocks.mockResolvedValue(emptyResponse)
  mockedBatchResolve.mockResolvedValue([])
  mockedListProjectedAgenda.mockResolvedValue({
    items: [],
    next_cursor: null,
    has_more: false,
    total_count: null,
  })
  mockedQueryByProperty.mockResolvedValue(emptyResponse)
  useNavigationStore.setState({
    currentView: 'journal',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
})

/** Waits for the panel to list `count` task rows. */
function findRows(count: number): Promise<HTMLElement[]> {
  return waitFor(() => {
    const rows = screen.getAllByTestId('due-panel-item')
    expect(rows).toHaveLength(count)
    return rows
  })
}

describe('DuePanel', () => {
  // #7155 R7 — the header names the panel; the counts are on today's tabs only.
  it('names the panel in its header, with no counts', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2' }), makeBlock({ id: 'B3' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DuePanel date="2025-06-15" />)

    await findRows(3)
    expect(screen.getByTestId('due-panel-header')).toHaveTextContent(/^Tasks$/)
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  // 2. Returns null when all sources are empty
  it('returns null when all sources are empty', async () => {
    mockedListBlocks.mockResolvedValue(emptyResponse)

    const { container } = render(<DuePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalled()
    })

    // Panel returns null when ALL tabs are empty
    await waitFor(() => {
      expect(container.innerHTML).toBe('')
    })
    expect(screen.queryByLabelText(t('duePanel.duePanelLabel'))).not.toBeInTheDocument()
  })

  // #7155 R7 — another day's tasks are one flat list, with no state groups.
  it("lists another day's tasks flat, with no group headings", async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B2', todo_state: 'DOING', content: 'doing block' }),
        makeBlock({ id: 'B3', todo_state: null, content: 'other block' }),
        makeBlock({ id: 'B4', todo_state: 'TODO', content: 'todo block' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DuePanel date="2025-06-15" />)

    await findRows(3)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  // The panel lists open tasks (#7155 D4): DONE is DonePanel's (#5074) and
  // CANCELLED is closed, both left out in SQL.
  it('lists the open block and leaves the DONE and CANCELLED ones out', async () => {
    seedAgendaListBlocks(mockedListBlocks, 'SPACE_1', [
      makeBlock({ id: 'B1', todo_state: 'TODO', content: 'todo block', due_date: DATE }),
      makeBlock({ id: 'B2', todo_state: 'DONE', content: 'done block', due_date: DATE }),
      makeBlock({ id: 'B3', todo_state: 'CANCELLED', content: 'cancelled block', due_date: DATE }),
    ])

    render(<DuePanel date="2025-06-15" />)

    await findRows(1)
    expect(screen.getByText('todo block')).toBeInTheDocument()
    expect(screen.queryByText('cancelled block')).not.toBeInTheDocument()
  })

  // #5074 — Agenda and Completed must never show the same block, and the
  // exclusion has to happen in SQL rather than after the fetch. `list_blocks`
  // pages at 50: a client-side DONE drop runs AFTER that cap, so a page that
  // is entirely DONE leaves the panel with nothing to render, `DuePanel`
  // returns `null`, and `LoadMoreButton` goes with it — every page behind it
  // is stranded (#738 sub-2's starvation, one surface over).
  //
  // The 50 DONE rows below sort ahead of the two open ones, so they fill that
  // whole first page. Driven through the tauri-mock's real `list_blocks`,
  // which honours `excludeTodoStates`, so the open rows arrive on page one.
  it('does not let a page of DONE rows starve the open ones (#5074)', async () => {
    const doneRows = Array.from({ length: 50 }, (_, i) =>
      makeBlock({
        id: `D${String(i).padStart(3, '0')}`,
        todo_state: 'DONE',
        content: `done ${i}`,
        due_date: DATE,
      }),
    )
    seedAgendaListBlocks(mockedListBlocks, 'SPACE_1', [
      ...doneRows,
      makeBlock({ id: 'Z1', todo_state: 'DOING', content: 'doing block', due_date: DATE }),
      makeBlock({ id: 'Z2', todo_state: 'TODO', content: 'todo block', due_date: DATE }),
    ])

    const { container } = render(<DuePanel date="2025-06-15" />)

    await findRows(2)
    expect(screen.getByText('doing block')).toBeInTheDocument()
    expect(screen.getByText('todo block')).toBeInTheDocument()
    expect(screen.queryByText('done 0')).not.toBeInTheDocument()
    expect(screen.queryByText('done 49')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('due-panel-item')).toHaveLength(2)
    expect(await axe(container)).toHaveNoViolations()
  })

  // 4. Sorts by priority within group (1 > 2 > 3 > null)
  it('sorts by priority', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', todo_state: 'TODO', priority: null, content: 'no priority' }),
        makeBlock({ id: 'B2', todo_state: 'TODO', priority: '3', content: 'priority three' }),
        makeBlock({ id: 'B3', todo_state: 'TODO', priority: '1', content: 'priority one' }),
        makeBlock({ id: 'B4', todo_state: 'TODO', priority: '2', content: 'priority two' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DuePanel date="2025-06-15" />)

    await findRows(4)

    // Get all block text items within the TODO group
    const items = screen.getAllByText(/priority (one|two|three)|no priority/)
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('priority one')
    expect(items[1]).toHaveTextContent('priority two')
    expect(items[2]).toHaveTextContent('priority three')
    expect(items[3]).toHaveTextContent('no priority')
  })

  // #5841 — a level from before the levels were fixed sorts after the levels.
  it('sorts an out-of-range priority after the levels', async () => {
    mockedListBlocks.mockResolvedValue({
      // Listed out-of-range first, so a no-op sort would keep that order.
      items: [
        makeBlock({ id: 'B1', todo_state: 'TODO', priority: 'P0', content: 'legacy priority' }),
        makeBlock({ id: 'B2', todo_state: 'TODO', priority: '3', content: 'level priority' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DuePanel date="2025-06-15" />)

    await findRows(2)

    const items = screen.getAllByText(/(legacy|level) priority/)
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('level priority')
    expect(items[1]).toHaveTextContent('legacy priority')
  })

  // 5. Shows loading skeleton during initial load
  it('shows loading skeleton during initial load', async () => {
    // Never-resolving promise to keep loading state
    mockedListBlocks.mockImplementation(() => new Promise(() => {}))

    const { container } = render(<DuePanel date="2025-06-15" />)

    // The component shows a skeleton while loading with no blocks
    await waitFor(() => {
      expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
    })
  })

  // 6. Shows source page breadcrumb from batchResolve
  it('shows source page breadcrumb from batchResolve', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1', page_id: 'PAGE1' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'My Page Title', block_type: 'page', deleted: false },
    ])

    render(<DuePanel date="2025-06-15" />)

    expect(await screen.findByText('My Page Title')).toBeInTheDocument()
  })

  // 7. Click navigates to source page
  it('click navigates to source page', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'click me' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Source Page', block_type: 'page', deleted: false },
    ])

    render(<DuePanel date="2025-06-15" onNavigateToPage={onNavigate} />)

    const blockItem = await screen.findByText('click me')
    const li = blockItem.closest('li') as HTMLElement
    await user.click(li)

    expect(onNavigate).toHaveBeenCalledWith('PAGE1', 'Source Page', 'BLOCK_1')
  })

  // 7b. Keyboard navigation on block (Enter)
  it('keyboard navigation on block (Enter)', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({
          id: 'BLOCK_1',
          parent_id: 'PAGE1',
          page_id: 'PAGE1',
          content: 'keyboard block',
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Source Page', block_type: 'page', deleted: false },
    ])

    render(<DuePanel date="2025-06-15" onNavigateToPage={onNavigate} />)

    const blockItem = await screen.findByText('keyboard block')
    const li = blockItem.closest('li') as HTMLElement
    li.focus()
    await user.keyboard('{Enter}')

    expect(onNavigate).toHaveBeenCalledWith('PAGE1', 'Source Page', 'BLOCK_1')
  })

  // ─── roving tabindex (#1520) ──────────────────────────────────────────
  // The doubled keyboard model (one container tab stop PLUS one native tab
  // stop per row) is fixed: rows rove so only the focused row is tabbable,
  // and the keyboard-nav container is no longer a tab stop of its own.
  describe('roving tabindex (#1520)', () => {
    it('exposes exactly ONE row tab stop (focused row 0); the rest rove to -1', async () => {
      mockedListBlocks.mockResolvedValue({
        items: [
          makeBlock({ id: 'B1', todo_state: 'TODO', content: 'row one' }),
          makeBlock({ id: 'B2', todo_state: 'TODO', content: 'row two' }),
          makeBlock({ id: 'B3', todo_state: 'TODO', content: 'row three' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2025-06-15" />)
      await screen.findByText('row one')

      const rows = screen.getAllByTestId('due-panel-item')
      expect(rows).toHaveLength(3)
      const tabStops = rows.filter((r) => r.getAttribute('tabindex') === '0')
      const roved = rows.filter((r) => r.getAttribute('tabindex') === '-1')
      // focusedIndex starts at 0 → only the first row is the tab stop.
      expect(tabStops).toHaveLength(1)
      expect(tabStops[0]).toHaveTextContent('row one')
      expect(roved).toHaveLength(2)
    })

    it('the keyboard-nav container is NOT itself a tab stop', async () => {
      mockedListBlocks.mockResolvedValue({
        items: [makeBlock({ id: 'B1', todo_state: 'TODO', content: 'only row' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2025-06-15" />)
      await screen.findByText('only row')

      const navContainer = document.querySelector('.due-panel-content') as HTMLElement
      expect(navContainer).toBeInTheDocument()
      // No tabindex on the container — the focused row is the single tab stop.
      expect(navContainer.getAttribute('tabindex')).toBeNull()
    })

    it('ArrowDown moves the single tab stop to the next row (roving follows focus)', async () => {
      const user = userEvent.setup()
      mockedListBlocks.mockResolvedValue({
        items: [
          makeBlock({ id: 'B1', todo_state: 'TODO', content: 'row one' }),
          makeBlock({ id: 'B2', todo_state: 'TODO', content: 'row two' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2025-06-15" />)
      await screen.findByText('row one')

      const rowOne = screen.getByText('row one').closest('li') as HTMLElement
      // Tab lands on the focused row 0; arrow keys bubble to the container handler.
      rowOne.focus()
      await user.keyboard('{ArrowDown}')

      await waitFor(() => {
        const rows = screen.getAllByTestId('due-panel-item')
        const tabStops = rows.filter((r) => r.getAttribute('tabindex') === '0')
        expect(tabStops).toHaveLength(1)
        expect(tabStops[0]).toHaveTextContent('row two')
        // The cursor (`list-cursor`) follows the roving tab stop.
        expect(tabStops[0]?.className).toContain('list-cursor')
      })
    })

    it('a11y: no violations with the roving model', async () => {
      mockedListBlocks.mockResolvedValue({
        items: [
          makeBlock({ id: 'B1', todo_state: 'TODO', content: 'row one' }),
          makeBlock({ id: 'B2', todo_state: 'TODO', content: 'row two' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      const { container } = render(<DuePanel date="2025-06-15" />)
      await screen.findByText('row one')

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // 8. Shows priority badge (P1/P2/P3)
  it('shows priority badges', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', priority: '1', content: 'urgent task' }),
        makeBlock({ id: 'B2', priority: '2', content: 'medium task' }),
        makeBlock({ id: 'B3', priority: '3', content: 'low task' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DuePanel date="2025-06-15" />)

    expect(await screen.findByText('P1')).toBeInTheDocument()
    expect(screen.getByText('P2')).toBeInTheDocument()
    expect(screen.getByText('P3')).toBeInTheDocument()
  })

  // 8b. Does not show priority badge when null
  it('does not show priority badge when null', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', priority: null, content: 'no prio' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DuePanel date="2025-06-15" />)

    await screen.findByText('no prio')

    expect(screen.queryByText(/^P\d$/)).not.toBeInTheDocument()
  })

  // 9. "Load more" button when hasMore=true, calls listBlocks with cursor
  it('shows load more button and fetches next page', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makeBlock({ id: 'B1', content: 'first block' })],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: null,
    }
    const page2 = {
      items: [makeBlock({ id: 'B2', content: 'second block' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    let callCount = 0
    mockedListBlocks.mockImplementation(async () => {
      callCount++
      return callCount === 1 ? page1 : page2
    })

    render(<DuePanel date="2025-06-15" />)

    const loadMoreBtn = await screen.findByRole('button', {
      name: /load more agenda items/i,
    })
    expect(loadMoreBtn).toBeInTheDocument()

    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'cursor_page2' }),
        expect.anything(),
      )
    })
  })

  // 9b. Hides load more when no more
  it('hides load more when no more', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'only block' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DuePanel date="2025-06-15" />)

    await screen.findByText('only block')

    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  // 10. Collapse/expand toggle works
  it('collapse/expand toggle works', async () => {
    const user = userEvent.setup()
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'visible block' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DuePanel date="2025-06-15" />)

    // Content should be visible (expanded by default)
    expect(await screen.findByText('visible block')).toBeInTheDocument()

    const section = screen.getByLabelText(t('duePanel.duePanelLabel'))
    expect(section.querySelector('.due-panel-content')).toBeInTheDocument()

    // Click header to collapse
    const header = screen.getByTestId('due-panel-header')
    await user.click(header)

    // Content should be hidden
    expect(section.querySelector('.due-panel-content')).not.toBeInTheDocument()

    // Click header to expand again
    await user.click(header)

    // Content should be visible again
    expect(section.querySelector('.due-panel-content')).toBeInTheDocument()
  })

  // 11. Re-fetches on date prop change
  it('re-fetches on date prop change', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    const { rerender } = render(<DuePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2025-06-15' }),
        expect.anything(),
      )
    })

    mockedListBlocks.mockClear()
    mockedBatchResolve.mockClear()

    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B2', due_date: '2025-06-16' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    rerender(<DuePanel date="2025-06-16" />)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ date: '2025-06-16' }),
        expect.anything(),
      )
    })
  })

  // 12. A11y audit passes (axe)
  it('a11y: no violations', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', todo_state: 'TODO', priority: '1', content: 'accessible block' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Page Title', block_type: 'page', deleted: false },
    ])

    const { container } = render(<DuePanel date="2025-06-15" />)

    await screen.findByText('accessible block')

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // 20. Panel returns null when all sources are empty (supersedes B-43)
  it('returns null when all data sources return empty', async () => {
    // All data sources return empty
    mockedListBlocks.mockResolvedValue(emptyResponse)
    mockedListProjectedAgenda.mockResolvedValue({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedQueryByProperty.mockResolvedValue(emptyResponse)

    const { container } = render(<DuePanel date="2025-06-15" />)

    // Wait for loading to finish
    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalled()
    })

    // Panel returns null when ALL tabs are empty
    await waitFor(() => {
      expect(container.innerHTML).toBe('')
    })
    expect(screen.queryByLabelText(t('duePanel.duePanelLabel'))).not.toBeInTheDocument()
  })

  // --- Projected agenda entries (repeating tasks) ---
  describe('projected entries', () => {
    it('renders projected entries section when projections exist', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ1',
              content: 'Projected task',
              parent_id: 'PAGE1',
              page_id: 'PAGE1',
              todo_state: 'TODO',
              priority: '2',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2026-04-13" />)

      // An h2, beside the Overdue / Upcoming section titles: both hosts head the panel with an h1.
      expect(
        await screen.findByRole('heading', { level: 2, name: t('due.projected') }),
      ).toBeInTheDocument()
      expect(screen.getByText(/Projected task/)).toBeInTheDocument()
    })

    // #7040 — a projected occurrence shows its date as the chip of the date it
    // was projected from, after its text, in place of an emoji before it.
    it.each([
      ['due_date', 'due'],
      ['scheduled_date', 'scheduled'],
    ] as const)('a row projected from %s ends in the %s date chip', async (source, kind) => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ1',
              content: 'Projected task',
              parent_id: 'PAGE1',
              page_id: 'PAGE1',
              todo_state: 'TODO',
            }),
            projected_date: '2026-04-13',
            source,
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2026-04-13" />)

      const row = await screen.findByTestId('projected-entry')
      const chip = row.querySelector('[data-date-kind]') as HTMLElement
      expect(chip).toHaveAttribute('data-date-kind', kind)
      expect(chip.querySelector('time')).toHaveAttribute('datetime', '2026-04-13')
      const text = within(row).getByText(/Projected task/)
      expect(text.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('does not render projected section when no projections', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2026-04-13" />)

      // Wait for loading to finish
      await waitFor(() => {
        expect(screen.queryByText('Projected')).not.toBeInTheDocument()
      })
    })

    // Per-entry "Projected" badge so users don't misread projected
    // entries as real tasks due today.
    it('renders a per-entry "Projected" badge for each projected entry', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ_BADGE_1',
              content: 'First projected',
              parent_id: null,
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
          {
            block: makeBlock({
              id: 'PROJ_BADGE_2',
              content: 'Second projected',
              parent_id: null,
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2026-04-13" />)

      await screen.findByText(/First projected/)

      // One badge per projected entry, plus the section header.
      // Badge has data-slot="badge" set by the Badge primitive.
      const badges = document.querySelectorAll('[data-slot="badge"]')
      // 2 projected entries → 2 "Projected" badges (priority badges live
      // elsewhere only when priority is set; these blocks have no priority).
      const projectedBadges = Array.from(badges).filter((b) => b.textContent?.includes('Projected'))
      expect(projectedBadges).toHaveLength(2)
    })

    it('shows the projected content text', async () => {
      const longContent = 'A very long projected task content that will be truncated visually'
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ_TITLE',
              content: longContent,
              parent_id: null,
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2026-04-13" />)

      const li = await screen.findByTestId('projected-entry')
      expect(li).toHaveTextContent(longContent)
    })

    it('projected entry navigates to parent page on click', async () => {
      const onNavigate = vi.fn()
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ2',
              content: 'Navigate me',
              parent_id: 'PAGE2',
              page_id: 'PAGE2',
              todo_state: 'TODO',
              due_date: '2026-04-20',
            }),
            projected_date: '2026-04-20',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedBatchResolve.mockResolvedValue([
        { id: 'PAGE2', title: 'My Page', block_type: 'page', deleted: false },
      ])

      const user = userEvent.setup()
      render(<DuePanel date="2026-04-20" onNavigateToPage={onNavigate} />)

      const item = await screen.findByText(/Navigate me/)
      await user.click(item.closest('li') as HTMLElement)

      expect(onNavigate).toHaveBeenCalledWith('PAGE2', 'My Page', 'PROJ2')
    })

    it('uses the translated untitled label when a projected page title is unresolved', async () => {
      const onNavigate = vi.fn()
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ_UNTITLED',
              content: 'Navigate without a resolved title',
              parent_id: 'PAGE_UNTITLED',
              page_id: 'PAGE_UNTITLED',
              todo_state: 'TODO',
              due_date: '2026-04-20',
            }),
            projected_date: '2026-04-20',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      const user = userEvent.setup()
      render(<DuePanel date="2026-04-20" onNavigateToPage={onNavigate} />)

      const item = await screen.findByText(/Navigate without a resolved title/)
      await user.click(item.closest('li') as HTMLElement)

      expect(onNavigate).toHaveBeenCalledWith(
        'PAGE_UNTITLED',
        t('duePanel.untitled'),
        'PROJ_UNTITLED',
      )
    })

    it('projected entries show priority badge when priority is set', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ3',
              content: 'Priority task',
              parent_id: null,
              todo_state: 'TODO',
              priority: '1',
              due_date: '2026-04-27',
            }),
            projected_date: '2026-04-27',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2026-04-27" />)

      expect(await screen.findByText('P1')).toBeInTheDocument()
    })

    it('has no a11y violations with projected entries', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'AXE1',
              content: 'Axe test task',
              parent_id: null,
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      const { container } = render(<DuePanel date="2026-04-13" />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    // Keyboard nav threads projected entries into the flat-items array
    it('keyboard nav reaches projected entries via ArrowDown', async () => {
      // 2 real (TODO) + 1 projected → flat-items length 3.
      // focusedIndex starts at 0. ArrowDown ArrowDown lands on index 2 (projected).
      mockedListBlocks.mockResolvedValue({
        items: [
          makeBlock({
            id: 'R1',
            content: 'Real task one',
            todo_state: 'TODO',
            parent_id: 'PAGE_R1',
            page_id: 'PAGE_R1',
          }),
          makeBlock({
            id: 'R2',
            content: 'Real task two',
            todo_state: 'TODO',
            parent_id: 'PAGE_R2',
            page_id: 'PAGE_R2',
          }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ_KB',
              content: 'Projected nav target',
              parent_id: 'PAGE2',
              page_id: 'PAGE2',
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedBatchResolve.mockResolvedValue([
        { id: 'PAGE2', title: 'Projected Page', block_type: 'page', deleted: false },
      ])

      const onNavigate = vi.fn()
      const user = userEvent.setup()
      render(<DuePanel date="2026-04-13" onNavigateToPage={onNavigate} />)

      // Wait for real + projected items to render
      await screen.findByText('Real task one')
      await screen.findByText(/Projected nav target/)

      // Projected entry has data-block-list-item so the scroll-into-view loop sees it
      const projectedItem = screen.getByTestId('projected-entry')
      expect(projectedItem.hasAttribute('data-block-list-item')).toBe(true)

      // The keyboard-nav handler lives on the .due-panel-content div (no
      // tabindex since #1520 — the focused row is the single tab stop);
      // ArrowDown events bubble from the focused row to this handler.
      const navContainer = document.querySelector('.due-panel-content') as HTMLElement
      expect(navContainer).toBeInTheDocument()
      navContainer.focus()

      // flat-items order: [R1 (0), R2 (1), PROJ_KB (2)]. focusedIndex=0 initially.
      // ArrowDown → 1, ArrowDown → 2 (projected), Enter selects.
      await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

      expect(onNavigate).toHaveBeenCalledWith('PAGE2', 'Projected Page', 'PROJ_KB')
    })

    // The cursor ring is gated on the cursor row's own :focus-visible, so DOM
    // focus has to cross from the grouped <ul> into the projected one with it.
    it('DOM focus follows the cursor from a grouped row into the projected list', async () => {
      mockedListBlocks.mockResolvedValue({
        items: [
          makeBlock({ id: 'R1', content: 'Real task one', todo_state: 'TODO', page_id: 'P1' }),
          makeBlock({ id: 'R2', content: 'Real task two', todo_state: 'TODO', page_id: 'P1' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ_FF',
              content: 'Projected follow target',
              page_id: 'P2',
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      const user = userEvent.setup()
      render(<DuePanel date="2026-04-13" />)
      await screen.findByText(/Projected follow target/)
      const realRows = await screen.findAllByTestId('due-panel-item')
      realRows[0]?.focus()

      await user.keyboard('{ArrowDown}')
      expect(realRows[1]).toHaveFocus()
      await user.keyboard('{ArrowDown}')
      expect(screen.getByTestId('projected-entry')).toHaveFocus()
    })

    // #5302 — End focuses the projected entry after a long list and scrolls it into view.
    it('End scrolls the projected entry into view after a long list', async () => {
      mockedListBlocks.mockResolvedValue({
        items: Array.from({ length: 30 }, (_, i) =>
          makeBlock({ id: `R${i}`, content: `Real task ${i}`, todo_state: 'TODO', page_id: 'P1' }),
        ),
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ_END',
              content: 'Projected end target',
              page_id: 'P2',
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})

      try {
        const user = userEvent.setup()
        render(<DuePanel date="2026-04-13" />)
        await screen.findByText(/Projected end target/)
        const realRows = await findRows(30)
        realRows[0]?.focus()

        await user.keyboard('{End}')

        const projected = screen.getByTestId('projected-entry')
        expect(projected).toHaveFocus()
        expect(scrollSpy.mock.instances).toContain(projected)
      } finally {
        scrollSpy.mockRestore()
      }
    })

    it('focused projected entry receives focus ring class', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ_FOCUS',
              content: 'Focus target',
              parent_id: 'PAGE_F',
              page_id: 'PAGE_F',
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2026-04-13" />)
      await screen.findByText(/Focus target/)

      // The single projected entry is the cursor (index 0) by default. At rest
      // it carries only `list-cursor`, whose ring is gated in CSS on keyboard
      // focus being in the list — never an inline ring.
      const li = screen.getByTestId('projected-entry')
      expect(li.className).toContain('list-cursor')
      expect(li.className).not.toContain('ring-2')
    })

    it('projected entries are deduplicated against real blocks', async () => {
      // Real block B1 appears in normal agenda
      mockedListBlocks.mockResolvedValue({
        items: [makeBlock({ id: 'B1', content: 'Real block', todo_state: 'TODO' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      // Projected entry also references B1
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'B1',
              content: 'Real block',
              parent_id: 'PAGE1',
              page_id: 'PAGE1',
              todo_state: 'TODO',
              due_date: '2025-06-15',
            }),
            projected_date: '2025-06-15',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2025-06-15" />)

      // Wait for the real block to appear
      await screen.findByText('Real block')

      // The "Projected" section should NOT appear since the only projected entry
      // is for a block that already exists in the real agenda
      await waitFor(() => {
        expect(screen.queryByText('Projected')).not.toBeInTheDocument()
      })
    })

    // #2193 — projected-entry rich content lives in a memoized
    // <ProjectedEntryContent> that parses inside a useMemo keyed on content +
    // resolve version. Arrow-key roving focus (which flips `focusedIndex` on
    // DuePanel every keypress) must not re-run renderRichContent for
    // unchanged projected rows.
    it('does not re-parse projected content on arrow-key focus navigation', async () => {
      const { renderRichContent } = await import('@/components/RichContentRenderer')
      const mockRender = vi.mocked(renderRichContent)

      mockedListBlocks.mockResolvedValue({
        items: [
          makeBlock({
            id: 'R1',
            content: 'Real task one',
            todo_state: 'TODO',
            parent_id: 'PAGE_R1',
            page_id: 'PAGE_R1',
          }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ_MEMO',
              content: 'Projected memo target',
              parent_id: 'PAGE_M',
              page_id: 'PAGE_M',
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      const user = userEvent.setup()
      render(<DuePanel date="2026-04-13" />)

      await screen.findByText('Real task one')
      await screen.findByText(/Projected memo target/)

      // Count renderRichContent calls for the projected content specifically.
      const projectedParseCount = () =>
        mockRender.mock.calls.filter((c) => c[0] === 'Projected memo target').length
      const before = projectedParseCount()
      expect(before).toBe(1)

      // Roving focus: flips focusedIndex on DuePanel, re-rendering it — the
      // memoized projected row must not re-parse.
      const navContainer = document.querySelector('.due-panel-content') as HTMLElement
      navContainer.focus()
      await user.keyboard('{ArrowDown}{ArrowUp}')

      // Output unchanged AND no additional parse of the projected content.
      expect(screen.getByText(/Projected memo target/)).toBeInTheDocument()
      expect(projectedParseCount()).toBe(before)
    })

    // #2200 — projected rows are rendered by a memoized <ProjectedEntryRow>
    // (mirroring the grouped-list <BlockListItem>) so DuePanel re-renders
    // driven by roving focus only re-render the rows whose `isFocused`
    // changed. This guards that the memo's isFocused prop is NOT stale: the
    // roving tab stop / focus ring must still follow ArrowDown across
    // projected entries after the structural markup was extracted behind memo.
    it('roving focus follows ArrowDown across memoized projected rows', async () => {
      const user = userEvent.setup()
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue({
        items: [
          {
            block: makeBlock({
              id: 'PROJ_A',
              content: 'Projected A',
              parent_id: 'PAGE_A',
              page_id: 'PAGE_A',
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
          {
            block: makeBlock({
              id: 'PROJ_B',
              content: 'Projected B',
              parent_id: 'PAGE_B',
              page_id: 'PAGE_B',
              todo_state: 'TODO',
              due_date: '2026-04-13',
            }),
            projected_date: '2026-04-13',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<DuePanel date="2026-04-13" />)

      await screen.findByText(/Projected A/)
      await screen.findByText(/Projected B/)

      // flat-items order (no real blocks): [PROJ_A (0), PROJ_B (1)].
      // focusedIndex starts at 0 → the FIRST projected row is the single tab
      // stop and carries the cursor; the second roves to -1.
      let rows = screen.getAllByTestId('projected-entry')
      expect(rows).toHaveLength(2)
      expect(rows[0]?.getAttribute('tabindex')).toBe('0')
      expect(rows[0]?.className).toContain('list-cursor')
      expect(rows[1]?.getAttribute('tabindex')).toBe('-1')
      expect(rows[1]?.className).not.toContain('list-cursor')

      // ArrowDown moves focus to the SECOND projected row. The memoized rows
      // must reflect the new isFocused prop (memo is not stale): the cursor and
      // the single tab stop move to row B, and row A drops both.
      const navContainer = document.querySelector('.due-panel-content') as HTMLElement
      navContainer.focus()
      await user.keyboard('{ArrowDown}')

      await waitFor(() => {
        rows = screen.getAllByTestId('projected-entry')
        expect(rows[1]?.getAttribute('tabindex')).toBe('0')
        expect(rows[1]?.className).toContain('list-cursor')
      })
      expect(rows[0]?.getAttribute('tabindex')).toBe('-1')
      expect(rows[0]?.className).not.toContain('list-cursor')
    })
  })

  // --- Today's tabs (#7155 R7) ---
  describe("today's tabs", () => {
    const TODAY = '2026-11-25' // a Wednesday: Friday is this week, next Thursday is later

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(`${TODAY}T12:00:00`))
      mockedQueryByProperty.mockResolvedValue({
        items: [
          makeBlock({
            id: 'LATE',
            content: 'Late task',
            todo_state: 'TODO',
            due_date: '2026-11-22',
          }),
          makeBlock({
            id: 'NOW',
            content: 'Task for today',
            todo_state: 'DOING',
            scheduled_date: TODAY,
          }),
          makeBlock({
            id: 'FRI',
            content: 'Friday task',
            todo_state: 'TODO',
            due_date: '2026-11-27',
          }),
          makeBlock({
            id: 'NEXT',
            content: 'Next week task',
            todo_state: 'TODO',
            scheduled_date: '2026-12-03',
          }),
          makeBlock({ id: 'UNDATED', content: 'Someday task', todo_state: 'TODO' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      // The day's own rows: a block dated today by a property, and a task the
      // open tasks hold too.
      mockedListBlocks.mockResolvedValue({
        items: [
          makeBlock({ id: 'PROP', content: 'Property-dated note', todo_state: null }),
          makeBlock({
            id: 'NOW',
            content: 'Task for today',
            todo_state: 'DOING',
            scheduled_date: TODAY,
          }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('counts each tab and shows every bucket under its heading on All', async () => {
      const { container } = render(<DuePanel date={TODAY} />)

      await findRows(6)
      const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
      expect(tabs).toEqual(['All 6', 'Overdue 1', 'Today 2', 'This week 1', 'Later 1', 'No date 1'])
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
        'Overdue',
        'Today',
        'This week',
        'Later',
        'No date',
      ])
      expect(screen.getByText(`(${t('duePanel.daysOverdue', { count: 3 })})`)).toBeInTheDocument()
      expect(await axe(container)).toHaveNoViolations()
    })

    it('a tab lists its own tasks alone, with no heading', async () => {
      const user = userEvent.setup()
      render(<DuePanel date={TODAY} />)
      await findRows(6)

      await user.click(screen.getByRole('tab', { name: /^No date/ }))

      const rows = await findRows(1)
      expect(rows[0]).toHaveTextContent('Someday task')
      expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()

      await user.click(screen.getByRole('tab', { name: /^Today/ }))

      const todayRows = await findRows(2)
      expect(todayRows[0]).toHaveTextContent('Task for today')
      expect(todayRows[1]).toHaveTextContent('Property-dated note')
    })

    it('on a later page, counts the tabs from that page’s date', async () => {
      render(<DuePanel date="2026-11-26" />)

      await findRows(6)
      // From Thursday the 26th: the 25th's task is overdue, Friday's is this
      // week; the day's own property-dated row is the 26th's.
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        'All 6',
        'Overdue 2',
        'Today 1',
        'This week 1',
        'Later 1',
        'No date 1',
      ])
      // A row's age still counts from the real today (the 25th), not the page's date.
      expect(screen.getByText(`(${t('duePanel.daysOverdue', { count: 3 })})`)).toBeInTheDocument()
    })

    it('ends This week where the week-start setting ends the week', async () => {
      const sunday = makeBlock({
        id: 'SUN',
        content: 'Sunday task',
        todo_state: 'TODO',
        due_date: '2026-11-29',
      })
      mockedQueryByProperty.mockResolvedValue({
        items: [sunday],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListBlocks.mockResolvedValue(emptyResponse)
      const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent)

      // Monday-start weeks (the default) end on Sunday the 29th.
      const { unmount } = render(<DuePanel date={TODAY} />)
      await findRows(1)
      expect(tabNames()).toContain('This week 1')
      unmount()

      // Sunday-start weeks end on Saturday the 28th, so the 29th is later.
      localStorage.setItem('week-start-preference', '0')
      try {
        render(<DuePanel date={TODAY} />)
        await findRows(1)
        expect(tabNames()).toContain('Later 1')
      } finally {
        localStorage.removeItem('week-start-preference')
      }
    })

    it('Group: Page keeps the keyboard cursor and Enter on the same row', async () => {
      mockedQueryByProperty.mockResolvedValue({
        items: [
          makeBlock({
            id: 'B1',
            content: 'Beta first',
            page_id: 'P_B',
            due_date: '2026-11-20',
            todo_state: 'TODO',
          }),
          makeBlock({
            id: 'A1',
            content: 'Alpha first',
            page_id: 'P_A',
            due_date: '2026-11-21',
            todo_state: 'TODO',
          }),
          makeBlock({
            id: 'B2',
            content: 'Beta second',
            page_id: 'P_B',
            due_date: '2026-11-22',
            todo_state: 'TODO',
          }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedBatchResolve.mockResolvedValue([
        { id: 'P_A', title: 'Alpha page', block_type: 'page', deleted: false },
        { id: 'P_B', title: 'Beta page', block_type: 'page', deleted: false },
      ])
      const onNavigateToPage = vi.fn()
      const user = userEvent.setup()
      render(<DuePanel date={TODAY} onNavigateToPage={onNavigateToPage} />)
      await findRows(3)
      await user.click(screen.getByTestId('due-panel-group'))
      await user.click(await screen.findByRole('button', { name: t('agenda.groupPage') }))
      await waitFor(() => {
        expect(screen.getAllByTestId('due-panel-page-group')).toHaveLength(2)
      })

      // The second row on screen is Beta second, under Beta page.
      const list = document.querySelector('.due-panel-content') as HTMLElement
      fireEvent.keyDown(list, { key: 'ArrowDown' })
      fireEvent.keyDown(list, { key: 'Enter' })

      expect(onNavigateToPage).toHaveBeenCalledWith('P_B', 'Beta page', 'B2')
      localStorage.removeItem('agaric:duePanel:groupBy')
    })

    it('Group: Page puts each page’s tasks under its heading, and the choice is kept', async () => {
      mockedQueryByProperty.mockResolvedValue({
        items: [
          makeBlock({
            id: 'B1',
            content: 'Beta first',
            page_id: 'P_B',
            due_date: '2026-11-20',
            todo_state: 'TODO',
          }),
          makeBlock({
            id: 'A1',
            content: 'Alpha first',
            page_id: 'P_A',
            due_date: '2026-11-21',
            todo_state: 'TODO',
          }),
          makeBlock({
            id: 'B2',
            content: 'Beta second',
            page_id: 'P_B',
            due_date: '2026-11-22',
            todo_state: 'TODO',
          }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedBatchResolve.mockResolvedValue([
        { id: 'P_A', title: 'Alpha page', block_type: 'page', deleted: false },
        { id: 'P_B', title: 'Beta page', block_type: 'page', deleted: false },
      ])
      const user = userEvent.setup()
      const { unmount } = render(<DuePanel date={TODAY} />)
      await findRows(3)

      await user.click(screen.getByTestId('due-panel-group'))
      await user.click(await screen.findByRole('button', { name: t('agenda.groupPage') }))

      await waitFor(() => {
        expect(screen.getAllByTestId('due-panel-page-group')).toHaveLength(2)
      })
      const groups = screen.getAllByTestId('due-panel-page-group')
      expect(within(groups[0] as HTMLElement).getByRole('heading')).toHaveTextContent('Beta page')
      expect(
        within(groups[0] as HTMLElement)
          .getAllByTestId('due-panel-item')
          .map((r) => r.textContent),
      ).toEqual([expect.stringContaining('Beta first'), expect.stringContaining('Beta second')])
      expect(within(groups[1] as HTMLElement).getByRole('heading')).toHaveTextContent('Alpha page')

      unmount()
      render(<DuePanel date={TODAY} />)
      await waitFor(() => {
        expect(screen.getAllByTestId('due-panel-page-group')).toHaveLength(2)
      })
      localStorage.removeItem('agaric:duePanel:groupBy')
    })

    it('a tab with no tasks says so', async () => {
      mockedQueryByProperty.mockResolvedValue({
        items: [makeBlock({ id: 'UNDATED', content: 'Someday task', todo_state: 'TODO' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      const user = userEvent.setup()
      render(<DuePanel date={TODAY} />)
      await screen.findByText('Someday task')

      await user.click(screen.getByRole('tab', { name: /^Later/ }))

      expect(await screen.findByText(t('duePanel.emptyTab'))).toBeInTheDocument()
      expect(screen.queryByTestId('due-panel-item')).not.toBeInTheDocument()
    })
  })

  // --- PageLink breadcrumb navigation ---
  it('clicking page title in breadcrumb navigates to the page', async () => {
    const user = userEvent.setup()
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({
          id: 'BK1',
          parent_id: 'PAGE1',
          page_id: 'PAGE1',
          content: 'breadcrumb nav test',
        }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Linked Page', block_type: 'page', deleted: false },
    ])

    render(<DuePanel date="2025-06-15" />)

    const pageLink = await screen.findByRole('link', { name: 'Linked Page' })
    await user.click(pageLink)

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(selectPageStack(useTabsStore.getState())).toHaveLength(1)
    expect(selectPageStack(useTabsStore.getState())[0]?.pageId).toBe('PAGE1')
    expect(selectPageStack(useTabsStore.getState())[0]?.title).toBe('Linked Page')
  })

  // --- Error paths ---
  describe('error paths', () => {
    it('listBlocks rejection on initial load returns null', async () => {
      mockedListBlocks.mockRejectedValueOnce(new Error('network failure'))

      const { container } = render(<DuePanel date="2025-06-15" />)

      // Wait for loading to finish — component returns null when all empty
      await waitFor(() => {
        expect(container.innerHTML).toBe('')
      })

      // Panel returns null when all sources are empty
      expect(screen.queryByLabelText(t('duePanel.duePanelLabel'))).not.toBeInTheDocument()
    })

    it('batchResolve rejection after listBlocks still renders blocks without page titles', async () => {
      mockedListBlocks.mockResolvedValueOnce({
        items: [
          makeBlock({ id: 'B1', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'resilient block' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedBatchResolve.mockRejectedValueOnce(new Error('resolve failure'))

      render(<DuePanel date="2025-06-15" />)

      // Block content should still appear even though title resolution failed
      expect(await screen.findByText('resilient block')).toBeInTheDocument()

      // Page title falls back to 'Untitled' since batchResolve failed
      expect(screen.getByText(t('duePanel.untitled'))).toBeInTheDocument()
    })

    it('listProjectedAgenda rejection shows toast error and no projected section', async () => {
      mockedListBlocks.mockResolvedValueOnce({
        items: [makeBlock({ id: 'B1', content: 'normal block' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListProjectedAgenda.mockRejectedValueOnce(new Error('projected fetch failed'))

      render(<DuePanel date="2025-06-15" />)

      // Normal blocks still render
      expect(await screen.findByText('normal block')).toBeInTheDocument()

      // Toast error was shown
      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          'Failed to load agenda',
          expect.objectContaining({ id: 'due-panel-load-failed' }),
        )
      })

      // No projected section
      expect(screen.queryByText('Projected')).not.toBeInTheDocument()
    })

    it('batchResolve rejection after listProjectedAgenda shows toast error', async () => {
      mockedListBlocks.mockResolvedValueOnce(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValueOnce({
        items: [
          {
            block: makeBlock({
              id: 'PROJ1',
              content: 'Projected task',
              parent_id: 'PAGE2',
              page_id: 'PAGE2',
              todo_state: 'TODO',
              due_date: '2025-06-15',
            }),
            projected_date: '2025-06-15',
            source: 'due_date',
          },
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      // listBlocks returns empty so no batchResolve is triggered from that path.
      // The only batchResolve call comes from the projected entries path.
      mockedBatchResolve.mockRejectedValueOnce(new Error('resolve projected failure'))

      render(<DuePanel date="2025-06-15" />)

      // Projected entry still renders (batchResolve only fails for title resolution)
      expect(await screen.findByText(/Projected task/)).toBeInTheDocument()

      // Toast error was shown for the failed title resolution
      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          'Failed to load agenda',
          expect.objectContaining({ id: 'due-panel-load-failed' }),
        )
      })
    })

    it('queryByProperty rejection for the open tasks returns null when all empty', async () => {
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

      mockedListBlocks.mockResolvedValueOnce(emptyResponse)
      mockedQueryByProperty.mockRejectedValueOnce(new Error('open tasks query failed'))

      const { container } = render(<DuePanel date={todayStr} />)

      // Wait for loading to finish
      await waitFor(() => {
        expect(mockedListBlocks).toHaveBeenCalled()
      })

      // Panel returns null when all sources are empty
      await waitFor(() => {
        expect(container.innerHTML).toBe('')
      })
    })

    it('listBlocks rejection on loadMore preserves existing blocks', async () => {
      const user = userEvent.setup()
      mockedListBlocks.mockResolvedValueOnce({
        items: [makeBlock({ id: 'B1', content: 'first block' })],
        next_cursor: 'cursor_page2',
        has_more: true,
        total_count: null,
      })

      render(<DuePanel date="2025-06-15" />)

      // First page loads fine
      expect(await screen.findByText('first block')).toBeInTheDocument()

      // Now make loadMore fail
      mockedListBlocks.mockRejectedValueOnce(new Error('loadMore network failure'))

      const loadMoreBtn = screen.getByRole('button', { name: /load more agenda items/i })
      await user.click(loadMoreBtn)

      // Wait for the failed request to complete
      await waitFor(() => {
        expect(mockedListBlocks).toHaveBeenCalledTimes(2)
      })

      // Original block is still displayed — state not corrupted
      expect(screen.getByText('first block')).toBeInTheDocument()

      // Component still renders without crashing
      expect(screen.getByLabelText(t('duePanel.duePanelLabel'))).toBeInTheDocument()
    })
  })
})
