/**
 * Tests for DuePanel component (#600).
 *
 * Validates:
 *  1. Renders with items showing count header ("3 Due")
 *  2. Returns null / does not render when no items (totalCount 0)
 *  3. Groups blocks by todo_state in correct order (DOING > TODO > DONE > null)
 *  4. Sorts by priority within group (1 > 2 > 3 > null)
 *  5. Shows loading spinner during fetch
 *  6. Shows source page breadcrumb from batchResolve
 *  7. Click navigates to source page
 *  8. Shows priority badge (P1/P2/P3)
 *  9. "Load more" button when hasMore=true
 *  10. Collapse/expand toggle works
 *  11. Re-fetches on date prop change
 *  12. A11y audit passes (axe)
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { clearProjectedCache } from '../../hooks/useDuePanelData'

vi.mock('../../lib/tauri', () => ({
  listBlocks: vi.fn(),
  batchResolve: vi.fn(),
  listProjectedAgenda: vi.fn(),
  queryByProperty: vi.fn(),
  getBlock: vi.fn(),
  setDueDate: vi.fn(),
  setScheduledDate: vi.fn(),
}))

vi.mock('../StaticBlock', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

vi.mock('../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
}))

vi.mock('lucide-react', () => ({
  ChevronRight: (props: Record<string, unknown>) => <svg data-testid="chevron-right" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <svg data-testid="chevron-down" {...props} />,
  CheckCircle2: (props: Record<string, unknown>) => <svg data-testid="check-circle" {...props} />,
  Loader2: (props: Record<string, unknown>) => <svg data-testid="loader-spinner" {...props} />,
  CalendarDays: (props: Record<string, unknown>) => <svg data-testid="calendar-days" {...props} />,
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

import { toast } from 'sonner'
import { makeBlock } from '../../__tests__/fixtures'
import { batchResolve, listBlocks, listProjectedAgenda, queryByProperty } from '../../lib/tauri'
import { selectPageStack, useNavigationStore } from '../../stores/navigation'
import { DuePanel } from '../DuePanel'

const mockedListBlocks = vi.mocked(listBlocks)
const mockedBatchResolve = vi.mocked(batchResolve)
const mockedListProjectedAgenda = vi.mocked(listProjectedAgenda)
const mockedQueryByProperty = vi.mocked(queryByProperty)
const mockedToastError = vi.mocked(toast.error)

const emptyResponse = {
  items: [],
  next_cursor: null,
  has_more: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  clearProjectedCache()
  mockedListBlocks.mockResolvedValue(emptyResponse)
  mockedBatchResolve.mockResolvedValue([])
  mockedListProjectedAgenda.mockResolvedValue([])
  mockedQueryByProperty.mockResolvedValue(emptyResponse)
  useNavigationStore.setState({
    currentView: 'journal',
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
})

describe('DuePanel', () => {
  // 1. Renders with items showing count header ("3 Agenda")
  it('renders header with correct count', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2' }), makeBlock({ id: 'B3' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    expect(await screen.findByText(t('duePanel.header', { count: 3 }))).toBeInTheDocument()
  })

  // 1b. Singular count
  it('renders singular count header ("1 Agenda")', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    expect(await screen.findByText(t('duePanel.headerOne'))).toBeInTheDocument()
  })

  // 2. Returns null when all sources are empty (UX-152)
  it('returns null when all sources are empty', async () => {
    mockedListBlocks.mockResolvedValue(emptyResponse)

    const { container } = render(<DuePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalled()
    })

    // UX-152: Panel returns null when ALL tabs are empty
    await waitFor(() => {
      expect(container.innerHTML).toBe('')
    })
    expect(screen.queryByLabelText(t('duePanel.duePanelLabel'))).not.toBeInTheDocument()
  })

  // 3. Groups blocks by todo_state in correct order (DOING > TODO > DONE > null)
  it('groups blocks by todo_state in correct order', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', todo_state: 'DONE', content: 'done block' }),
        makeBlock({ id: 'B2', todo_state: 'DOING', content: 'doing block' }),
        makeBlock({ id: 'B3', todo_state: null, content: 'other block' }),
        makeBlock({ id: 'B4', todo_state: 'TODO', content: 'todo block' }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    await screen.findByText(t('duePanel.header', { count: 4 }))

    // Verify group headers appear in correct order
    const groupHeaders = screen.getAllByText(/^(DOING|TODO|DONE|Other)$/)
    expect(groupHeaders).toHaveLength(4)
    expect(groupHeaders[0]).toHaveTextContent(t('duePanel.groupDoing'))
    expect(groupHeaders[1]).toHaveTextContent(t('duePanel.groupTodo'))
    expect(groupHeaders[2]).toHaveTextContent(t('duePanel.groupDone'))
    expect(groupHeaders[3]).toHaveTextContent(t('duePanel.groupOther'))
  })

  // 4. Sorts by priority within group (1 > 2 > 3 > null)
  it('sorts by priority within group', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', todo_state: 'TODO', priority: null, content: 'no priority' }),
        makeBlock({ id: 'B2', todo_state: 'TODO', priority: '3', content: 'priority three' }),
        makeBlock({ id: 'B3', todo_state: 'TODO', priority: '1', content: 'priority one' }),
        makeBlock({ id: 'B4', todo_state: 'TODO', priority: '2', content: 'priority two' }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    await screen.findByText(t('duePanel.header', { count: 4 }))

    // Get all block text items within the TODO group
    const items = screen.getAllByText(/priority (one|two|three)|no priority/)
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('priority one')
    expect(items[1]).toHaveTextContent('priority two')
    expect(items[2]).toHaveTextContent('priority three')
    expect(items[3]).toHaveTextContent('no priority')
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
    }
    const page2 = {
      items: [makeBlock({ id: 'B2', content: 'second block' })],
      next_cursor: null,
      has_more: false,
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
      )
    })
  })

  // 9b. Hides load more when no more
  it('hides load more when no more', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'only block' })],
      next_cursor: null,
      has_more: false,
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
    })

    render(<DuePanel date="2025-06-15" />)

    // Content should be visible (expanded by default)
    expect(await screen.findByText('visible block')).toBeInTheDocument()

    const section = screen.getByLabelText(t('duePanel.duePanelLabel'))
    expect(section.querySelector('.due-panel-content')).toBeInTheDocument()

    // Click header to collapse
    const header = screen.getByText(t('duePanel.headerOne'))
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
    })

    const { rerender } = render(<DuePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ agendaDate: '2025-06-15' }),
      )
    })

    mockedListBlocks.mockClear()
    mockedBatchResolve.mockClear()

    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B2', due_date: '2025-06-16' })],
      next_cursor: null,
      has_more: false,
    })

    rerender(<DuePanel date="2025-06-16" />)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ agendaDate: '2025-06-16' }),
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

  // 13. "All" filter is selected by default
  it('shows "All" filter selected by default', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'filter test block' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    await screen.findByText('filter test block')

    const allBtn = screen.getByRole('button', { name: /^All( \(\d+\))?$/ })
    const dueBtn = screen.getByRole('button', { name: /^Due( \(\d+\))?$/ })
    const scheduledBtn = screen.getByRole('button', { name: /^Scheduled( \(\d+\))?$/ })
    const propsBtn = screen.getByRole('button', { name: /^Properties( \(\d+\))?$/ })

    expect(allBtn).toHaveAttribute('aria-pressed', 'true')
    expect(dueBtn).toHaveAttribute('aria-pressed', 'false')
    expect(scheduledBtn).toHaveAttribute('aria-pressed', 'false')
    expect(propsBtn).toHaveAttribute('aria-pressed', 'false')
  })

  // 14. Clicking "Due" filter refetches with agendaSource
  it('clicking "Due" filter refetches with agendaSource', async () => {
    const user = userEvent.setup()
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'due filter block' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    await screen.findByText('due filter block')

    mockedListBlocks.mockClear()
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B2', content: 'filtered due block' })],
      next_cursor: null,
      has_more: false,
    })

    const dueBtn = screen.getByRole('button', { name: /^Due/ })
    await user.click(dueBtn)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ agendaSource: 'column:due_date' }),
      )
    })

    expect(dueBtn).toHaveAttribute('aria-pressed', 'true')
  })

  // 15. Clicking "All" clears source filter
  it('clicking "All" clears source filter', async () => {
    const user = userEvent.setup()
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'all filter block' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    await screen.findByText('all filter block')

    // First click "Due" to set a filter
    const dueBtn = screen.getByRole('button', { name: /^Due/ })
    await user.click(dueBtn)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.objectContaining({ agendaSource: 'column:due_date' }),
      )
    })

    mockedListBlocks.mockClear()
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B3', content: 'all blocks again' })],
      next_cursor: null,
      has_more: false,
    })

    // Now click "All" to clear the filter
    const allBtn = screen.getByRole('button', { name: /^All/ })
    await user.click(allBtn)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.not.objectContaining({ agendaSource: expect.any(String) }),
      )
    })

    expect(allBtn).toHaveAttribute('aria-pressed', 'true')
  })

  // 16. Clicking "Properties" filter fetches without agendaSource and filters client-side
  it('clicking "Properties" filter fetches without agendaSource', async () => {
    const user = userEvent.setup()
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'props filter block' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    await screen.findByText('props filter block')

    mockedListBlocks.mockClear()
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B2', content: 'refetched block', due_date: null, scheduled_date: null }),
      ],
      next_cursor: null,
      has_more: false,
    })

    const propsBtn = screen.getByRole('button', { name: /^Properties/ })
    await user.click(propsBtn)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalledWith(
        expect.not.objectContaining({ agendaSource: expect.any(String) }),
      )
    })

    expect(propsBtn).toHaveAttribute('aria-pressed', 'true')
  })

  // 17. Properties filter shows only property-sourced blocks
  it('Properties filter shows only property-sourced blocks', async () => {
    const user = userEvent.setup()
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', content: 'due block', due_date: '2025-06-15', scheduled_date: null }),
        makeBlock({
          id: 'B2',
          content: 'scheduled block',
          due_date: null,
          scheduled_date: '2025-06-15',
          page_id: null,
        }),
        makeBlock({ id: 'B3', content: 'property block', due_date: null, scheduled_date: null }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    // All 3 blocks visible initially
    await screen.findByText('due block')
    expect(screen.getByText('scheduled block')).toBeInTheDocument()
    expect(screen.getByText('property block')).toBeInTheDocument()

    // Click "Properties" filter
    const propsBtn = screen.getByRole('button', { name: /^Properties/ })
    await user.click(propsBtn)

    // Only property-sourced block remains
    await waitFor(() => {
      expect(screen.queryByText('due block')).not.toBeInTheDocument()
      expect(screen.queryByText('scheduled block')).not.toBeInTheDocument()
      expect(screen.getByText('property block')).toBeInTheDocument()
    })
  })

  // 18. Header shows per-source breakdown when multiple sources exist
  it('header shows per-source breakdown when multiple sources exist', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', content: 'due1', due_date: '2025-06-15', scheduled_date: null }),
        makeBlock({ id: 'B2', content: 'due2', due_date: '2025-06-15', scheduled_date: null }),
        makeBlock({
          id: 'B3',
          content: 'sched1',
          due_date: null,
          scheduled_date: '2025-06-15',
          page_id: null,
        }),
        makeBlock({ id: 'B4', content: 'prop1', due_date: null, scheduled_date: null }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    // Wait for blocks to load
    await screen.findByText('due1')

    // Header should show breakdown with middle dot separator
    expect(screen.getByText('2 Due \u00b7 1 Scheduled \u00b7 1 Properties')).toBeInTheDocument()
  })

  // 19. Header falls back to total count when only one source type
  it('header shows simple count when only one source type', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', content: 'due1', due_date: '2025-06-15', scheduled_date: null }),
        makeBlock({ id: 'B2', content: 'due2', due_date: '2025-06-15', scheduled_date: null }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    // All blocks are from due_date — falls back to "N Agenda" format
    expect(await screen.findByText(t('duePanel.header', { count: 2 }))).toBeInTheDocument()
  })

  // 20. Panel returns null when all sources are empty (UX-152 supersedes B-43)
  it('returns null when all data sources return empty', async () => {
    // All data sources return empty
    mockedListBlocks.mockResolvedValue(emptyResponse)
    mockedListProjectedAgenda.mockResolvedValue([])
    mockedQueryByProperty.mockResolvedValue(emptyResponse)

    const { container } = render(<DuePanel date="2025-06-15" />)

    // Wait for loading to finish
    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalled()
    })

    // UX-152: Panel returns null when ALL tabs are empty
    await waitFor(() => {
      expect(container.innerHTML).toBe('')
    })
    expect(screen.queryByLabelText(t('duePanel.duePanelLabel'))).not.toBeInTheDocument()
  })

  // --- Projected agenda entries (repeating tasks) ---
  describe('projected entries', () => {
    it('renders projected entries section when projections exist', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue([
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
      ])

      render(<DuePanel date="2026-04-13" />)

      expect(await screen.findByText('Projected')).toBeInTheDocument()
      expect(screen.getByText(/Projected task/)).toBeInTheDocument()
    })

    it('does not render projected section when no projections', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue([])

      render(<DuePanel date="2026-04-13" />)

      // Wait for loading to finish
      await waitFor(() => {
        expect(screen.queryByText('Projected')).not.toBeInTheDocument()
      })
    })

    it('projected entry navigates to parent page on click', async () => {
      const onNavigate = vi.fn()
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue([
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
      ])
      mockedBatchResolve.mockResolvedValue([
        { id: 'PAGE2', title: 'My Page', block_type: 'page', deleted: false },
      ])

      const user = userEvent.setup()
      render(<DuePanel date="2026-04-20" onNavigateToPage={onNavigate} />)

      const item = await screen.findByText(/Navigate me/)
      await user.click(item.closest('li') as HTMLElement)

      expect(onNavigate).toHaveBeenCalledWith('PAGE2', 'My Page', 'PROJ2')
    })

    it('projected entries show priority badge when priority is set', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue([
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
      ])

      render(<DuePanel date="2026-04-27" />)

      expect(await screen.findByText('P1')).toBeInTheDocument()
    })

    it('has no a11y violations with projected entries', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValue([
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
      ])

      const { container } = render(<DuePanel date="2026-04-13" />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    it('projected entries are deduplicated against real blocks', async () => {
      // Real block B1 appears in normal agenda
      mockedListBlocks.mockResolvedValue({
        items: [makeBlock({ id: 'B1', content: 'Real block', todo_state: 'TODO' })],
        next_cursor: null,
        has_more: false,
      })
      // Projected entry also references B1
      mockedListProjectedAgenda.mockResolvedValue([
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
      ])

      render(<DuePanel date="2025-06-15" />)

      // Wait for the real block to appear
      await screen.findByText('Real block')

      // The "Projected" section should NOT appear since the only projected entry
      // is for a block that already exists in the real agenda
      await waitFor(() => {
        expect(screen.queryByText('Projected')).not.toBeInTheDocument()
      })
    })
  })

  // --- Overdue blocks (#641) ---
  describe('overdue blocks', () => {
    it('shows overdue section when viewing today with overdue blocks', async () => {
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedQueryByProperty.mockResolvedValue({
        items: [
          makeBlock({
            id: 'OVERDUE1',
            content: 'Overdue task',
            parent_id: 'P1',
            page_id: 'P1',
            todo_state: 'TODO',
            priority: '1',
            due_date: '2025-01-01',
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<DuePanel date={todayStr} />)

      expect(await screen.findByText(t('duePanel.overdueTitle'))).toBeInTheDocument()
      expect(screen.getByText(/Overdue task/)).toBeInTheDocument()
    })

    it('does not show overdue section for non-today dates', async () => {
      mockedListBlocks.mockResolvedValue(emptyResponse)

      render(<DuePanel date="2025-06-15" />)

      await waitFor(() => {
        expect(screen.queryByText(t('duePanel.overdueTitle'))).not.toBeInTheDocument()
      })
    })

    it('does not show DONE blocks in overdue section', async () => {
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedQueryByProperty.mockResolvedValue({
        items: [
          makeBlock({
            id: 'DONE1',
            content: 'Done task',
            parent_id: null,
            todo_state: 'DONE',
            priority: null,
            due_date: '2025-01-01',
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<DuePanel date={todayStr} />)

      await waitFor(() => {
        expect(screen.queryByText(t('duePanel.overdueTitle'))).not.toBeInTheDocument()
      })
    })
  })

  // --- Hide-before-scheduled toggle (#641) ---
  describe('hide-before-scheduled toggle (#641)', () => {
    afterEach(() => {
      localStorage.removeItem('agaric:hideBeforeScheduled')
    })

    it('shows all blocks by default (toggle OFF)', async () => {
      const futureDate = '2099-12-31'
      mockedListBlocks.mockResolvedValue({
        items: [
          makeBlock({
            id: 'FUTURE1',
            content: 'Future scheduled',
            parent_id: null,
            todo_state: 'TODO',
            due_date: '2026-04-03',
            scheduled_date: futureDate,
            page_id: null,
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<DuePanel date="2026-04-03" />)
      expect(await screen.findByText(/Future scheduled/)).toBeInTheDocument()
    })

    it('hides future-scheduled blocks when toggle is ON', async () => {
      localStorage.setItem('agaric:hideBeforeScheduled', 'true')
      const futureDate = '2099-12-31'
      mockedListBlocks.mockResolvedValue({
        items: [
          makeBlock({
            id: 'FUTURE2',
            content: 'Hidden task',
            parent_id: null,
            todo_state: 'TODO',
            due_date: '2026-04-03',
            scheduled_date: futureDate,
            page_id: null,
          }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<DuePanel date="2026-04-03" />)

      // Block should be hidden
      await waitFor(() => {
        expect(screen.queryByText(/Hidden task/)).not.toBeInTheDocument()
      })
    })

    it('toggle button shows correct label', async () => {
      mockedListBlocks.mockResolvedValue({
        items: [makeBlock({ id: 'B1', content: 'label test block' })],
        next_cursor: null,
        has_more: false,
      })

      render(<DuePanel date="2026-04-03" />)

      // Default: show all
      const toggle = await screen.findByRole('button', { name: /Scheduled: show all/i })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
    })
  })

  // --- Deadline warning period (#641) ---
  describe('deadline warning period (#641)', () => {
    afterEach(() => {
      localStorage.removeItem('agaric:deadlineWarningDays')
    })

    it('shows upcoming section when warning days > 0 and tasks approach deadline', async () => {
      localStorage.setItem('agaric:deadlineWarningDays', '7')
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

      mockedListBlocks.mockResolvedValue(emptyResponse)
      mockedQueryByProperty.mockResolvedValue({
        items: [
          {
            id: 'UPCOMING1',
            block_type: 'content',
            content: 'Due soon task',
            parent_id: null,
            position: 1,
            deleted_at: null,
            is_conflict: false,
            conflict_type: null,
            todo_state: 'TODO',
            priority: null,
            due_date: tomorrowStr,
            scheduled_date: null,
            page_id: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<DuePanel date={todayStr} />)
      expect(await screen.findByText(t('duePanel.upcomingTitle'))).toBeInTheDocument()
      expect(screen.getByText(/Due soon task/)).toBeInTheDocument()
    })

    it('does not show upcoming section when warning days is 0', async () => {
      localStorage.setItem('agaric:deadlineWarningDays', '0')
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

      mockedListBlocks.mockResolvedValue(emptyResponse)

      render(<DuePanel date={todayStr} />)
      await waitFor(() => {
        expect(screen.queryByText(t('duePanel.upcomingTitle'))).not.toBeInTheDocument()
      })
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
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Linked Page', block_type: 'page', deleted: false },
    ])

    render(<DuePanel date="2025-06-15" />)

    const pageLink = await screen.findByRole('link', { name: 'Linked Page' })
    await user.click(pageLink)

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(selectPageStack(navState)).toHaveLength(1)
    expect(selectPageStack(navState)[0]?.pageId).toBe('PAGE1')
    expect(selectPageStack(navState)[0]?.title).toBe('Linked Page')
  })

  // --- Error paths ---
  describe('error paths', () => {
    it('listBlocks rejection on initial load returns null (UX-152)', async () => {
      mockedListBlocks.mockRejectedValueOnce(new Error('network failure'))

      const { container } = render(<DuePanel date="2025-06-15" />)

      // Wait for loading to finish — component returns null when all empty
      await waitFor(() => {
        expect(container.innerHTML).toBe('')
      })

      // UX-152: Panel returns null when all sources are empty
      expect(screen.queryByLabelText(t('duePanel.duePanelLabel'))).not.toBeInTheDocument()
    })

    it('batchResolve rejection after listBlocks still renders blocks without page titles', async () => {
      mockedListBlocks.mockResolvedValueOnce({
        items: [
          makeBlock({ id: 'B1', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'resilient block' }),
        ],
        next_cursor: null,
        has_more: false,
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
      })
      mockedListProjectedAgenda.mockRejectedValueOnce(new Error('projected fetch failed'))

      render(<DuePanel date="2025-06-15" />)

      // Normal blocks still render
      expect(await screen.findByText('normal block')).toBeInTheDocument()

      // Toast error was shown
      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith('duePanel.loadAgendaFailed')
      })

      // No projected section
      expect(screen.queryByText('Projected')).not.toBeInTheDocument()
    })

    it('batchResolve rejection after listProjectedAgenda shows toast error', async () => {
      mockedListBlocks.mockResolvedValueOnce(emptyResponse)
      mockedListProjectedAgenda.mockResolvedValueOnce([
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
      ])
      // listBlocks returns empty so no batchResolve is triggered from that path.
      // The only batchResolve call comes from the projected entries path.
      mockedBatchResolve.mockRejectedValueOnce(new Error('resolve projected failure'))

      render(<DuePanel date="2025-06-15" />)

      // Projected entry still renders (batchResolve only fails for title resolution)
      expect(await screen.findByText(/Projected task/)).toBeInTheDocument()

      // Toast error was shown for the failed title resolution
      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith('duePanel.loadAgendaFailed')
      })
    })

    it('queryByProperty rejection for overdue fetch returns null when all empty (UX-152)', async () => {
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

      mockedListBlocks.mockResolvedValueOnce(emptyResponse)
      mockedQueryByProperty.mockRejectedValueOnce(new Error('overdue query failed'))

      const { container } = render(<DuePanel date={todayStr} />)

      // Wait for loading to finish
      await waitFor(() => {
        expect(mockedListBlocks).toHaveBeenCalled()
      })

      // Overdue section should not appear
      await waitFor(() => {
        expect(screen.queryByText(t('duePanel.overdueTitle'))).not.toBeInTheDocument()
      })

      // UX-152: Panel returns null when all sources are empty
      await waitFor(() => {
        expect(container.innerHTML).toBe('')
      })
    })

    it('queryByProperty rejection for upcoming fetch returns null when all empty (UX-152)', async () => {
      localStorage.setItem('agaric:deadlineWarningDays', '7')
      const today = new Date()
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

      mockedListBlocks.mockResolvedValueOnce(emptyResponse)
      // queryByProperty is called twice when isToday && warningDays > 0: once for overdue, once for upcoming.
      // Let overdue succeed, upcoming fail.
      mockedQueryByProperty
        .mockResolvedValueOnce(emptyResponse)
        .mockRejectedValueOnce(new Error('upcoming query failed'))

      const { container } = render(<DuePanel date={todayStr} />)

      // Wait for loading to finish
      await waitFor(() => {
        expect(mockedQueryByProperty).toHaveBeenCalledTimes(2)
      })

      // Upcoming section should not appear
      expect(screen.queryByText(t('duePanel.upcomingTitle'))).not.toBeInTheDocument()

      // UX-152: Panel returns null when all sources are empty
      await waitFor(() => {
        expect(container.innerHTML).toBe('')
      })

      localStorage.removeItem('agaric:deadlineWarningDays')
    })

    it('listBlocks rejection on loadMore preserves existing blocks', async () => {
      const user = userEvent.setup()
      mockedListBlocks.mockResolvedValueOnce({
        items: [makeBlock({ id: 'B1', content: 'first block' })],
        next_cursor: 'cursor_page2',
        has_more: true,
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
