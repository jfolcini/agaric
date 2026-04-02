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
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('../../lib/tauri', () => ({
  listBlocks: vi.fn(),
  batchResolve: vi.fn(),
}))

vi.mock('lucide-react', () => ({
  ChevronRight: (props: Record<string, unknown>) => <svg data-testid="chevron-right" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <svg data-testid="chevron-down" {...props} />,
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
import { batchResolve, listBlocks } from '../../lib/tauri'
import { DuePanel } from '../DuePanel'

const mockedListBlocks = vi.mocked(listBlocks)
const mockedBatchResolve = vi.mocked(batchResolve)

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
    todo_state: null,
    priority: null,
    due_date: '2025-06-15',
    scheduled_date: null,
    ...overrides,
  }
}

const emptyResponse = {
  items: [],
  next_cursor: null,
  has_more: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedListBlocks.mockResolvedValue(emptyResponse)
  mockedBatchResolve.mockResolvedValue([])
})

describe('DuePanel', () => {
  // 1. Renders with items showing count header ("3 Due")
  it('renders header with correct count', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2' }), makeBlock({ id: 'B3' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    expect(await screen.findByText('3 Due')).toBeInTheDocument()
  })

  // 1b. Singular count
  it('renders singular count header ("1 Due")', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DuePanel date="2025-06-15" />)

    expect(await screen.findByText('1 Due')).toBeInTheDocument()
  })

  // 2. Returns null / does not render when no items
  it('does not render when no items', async () => {
    mockedListBlocks.mockResolvedValue(emptyResponse)

    const { container } = render(<DuePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(mockedListBlocks).toHaveBeenCalled()
    })

    expect(container.querySelector('.due-panel')).not.toBeInTheDocument()
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

    await screen.findByText('4 Due')

    // Verify group headers appear in correct order
    const groupHeaders = screen.getAllByText(/^(DOING|TODO|DONE|Other)$/)
    expect(groupHeaders).toHaveLength(4)
    expect(groupHeaders[0]).toHaveTextContent('DOING')
    expect(groupHeaders[1]).toHaveTextContent('TODO')
    expect(groupHeaders[2]).toHaveTextContent('DONE')
    expect(groupHeaders[3]).toHaveTextContent('Other')
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

    await screen.findByText('4 Due')

    // Get all block text items within the TODO group
    const items = screen.getAllByText(/priority (one|two|three)|no priority/)
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('priority one')
    expect(items[1]).toHaveTextContent('priority two')
    expect(items[2]).toHaveTextContent('priority three')
    expect(items[3]).toHaveTextContent('no priority')
  })

  // 5. Shows loading spinner during fetch
  it('shows loading spinner during fetch', async () => {
    // Never-resolving promise to keep loading state
    mockedListBlocks.mockImplementation(() => new Promise(() => {}))

    render(<DuePanel date="2025-06-15" />)

    // The component shows a spinner while loading with no blocks
    await waitFor(() => {
      expect(screen.getByTestId('loader-spinner')).toBeInTheDocument()
    })
  })

  // 6. Shows source page breadcrumb from batchResolve
  it('shows source page breadcrumb from batchResolve', async () => {
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1' })],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'My Page Title', block_type: 'page', deleted: false },
    ])

    render(<DuePanel date="2025-06-15" />)

    expect(await screen.findByText('→ My Page Title')).toBeInTheDocument()
  })

  // 7. Click navigates to source page
  it('click navigates to source page', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    mockedListBlocks.mockResolvedValue({
      items: [makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE1', content: 'click me' })],
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
      items: [makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE1', content: 'keyboard block' })],
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
      name: /load more due items/i,
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

    const section = screen.getByLabelText('Due items')
    expect(section.querySelector('.due-panel-content')).toBeInTheDocument()

    // Click header to collapse
    const header = screen.getByText('1 Due')
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
})
