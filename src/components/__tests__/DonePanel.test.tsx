/**
 * Tests for DonePanel component (#609).
 *
 * Validates:
 *  1. Renders with items showing count header ("3 Completed")
 *  2. Returns null / does not render when no items (totalCount 0)
 *  3. Groups by source page with page titles
 *  4. Sort blocks by ID descending within groups
 *  5. Shows loading spinner during fetch
 *  6. Shows source page breadcrumb from batchResolve
 *  7. Click navigates to source page
 *  8. Shows check icon per block
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
  queryByProperty: vi.fn(),
  batchResolve: vi.fn(),
  getBlock: vi.fn(),
  setDueDate: vi.fn(),
  setScheduledDate: vi.fn(),
}))

vi.mock('../../hooks/useBlockPropertyEvents', () => ({
  useBlockPropertyEvents: vi.fn(() => ({ invalidationKey: 0 })),
}))

vi.mock('../../lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('lucide-react', () => ({
  ChevronRight: (props: Record<string, unknown>) => <svg data-testid="chevron-right" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <svg data-testid="chevron-down" {...props} />,
  CheckCircle2: (props: Record<string, unknown>) => <svg data-testid="check-circle" {...props} />,
  Loader2: (props: Record<string, unknown>) => <svg data-testid="loader-spinner" {...props} />,
  CalendarDays: (props: Record<string, unknown>) => <svg data-testid="calendar-days" {...props} />,
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

const mockNavigateToPage = vi.fn()

vi.mock('../PageLink', () => ({
  PageLink: ({
    pageId,
    title,
    className,
  }: {
    pageId: string
    title: string
    className?: string
  }) => (
    <button
      type="button"
      data-testid={`page-link-${pageId}`}
      className={className}
      onClick={(e) => {
        e.stopPropagation()
        mockNavigateToPage(pageId, title)
      }}
    >
      {title}
    </button>
  ),
}))

import { logger } from '../../lib/logger'
import type { BlockRow } from '../../lib/tauri'
import { batchResolve, queryByProperty } from '../../lib/tauri'
import { DonePanel } from '../DonePanel'

const mockedQueryByProperty = vi.mocked(queryByProperty)
const mockedBatchResolve = vi.mocked(batchResolve)

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
    todo_state: 'DONE',
    priority: null,
    due_date: null,
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
  mockNavigateToPage.mockClear()
  mockedQueryByProperty.mockResolvedValue(emptyResponse)
  mockedBatchResolve.mockResolvedValue([])
})

describe('DonePanel', () => {
  // 1. Renders with items showing count header ("3 Completed")
  it('renders header with correct count', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B1' }), makeBlock({ id: 'B2' }), makeBlock({ id: 'B3' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DonePanel date="2025-06-15" />)

    expect(await screen.findByText('3 Completed')).toBeInTheDocument()
  })

  // 1b. Singular count
  it('renders singular count header ("1 Completed")', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DonePanel date="2025-06-15" />)

    expect(await screen.findByText('1 Completed')).toBeInTheDocument()
  })

  // 2. Returns null when no items (UX-130)
  it('does not render when no items', async () => {
    mockedQueryByProperty.mockResolvedValue(emptyResponse)

    const { container } = render(<DonePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(mockedQueryByProperty).toHaveBeenCalled()
    })

    // UX-130: component returns null when empty
    expect(container.querySelector('.done-panel')).not.toBeInTheDocument()
    expect(screen.queryByText('No completed items yet.')).not.toBeInTheDocument()
  })

  // 3. Groups by source page with page titles
  it('groups blocks by source page with page titles', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', parent_id: 'PAGE1', content: 'block in alpha' }),
        makeBlock({ id: 'B2', parent_id: 'PAGE2', content: 'block in beta' }),
        makeBlock({ id: 'B3', parent_id: 'PAGE1', content: 'another in alpha' }),
      ],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Alpha Page', block_type: 'page', deleted: false },
      { id: 'PAGE2', title: 'Beta Page', block_type: 'page', deleted: false },
    ])

    render(<DonePanel date="2025-06-15" />)

    await screen.findByText('3 Completed')

    // Group headers should show page titles with counts, sorted alphabetically
    const section = screen.getByLabelText('Completed items')
    const groupHeaders = section.querySelectorAll('.done-panel-group-header')
    expect(groupHeaders).toHaveLength(2)
    expect(groupHeaders[0]).toHaveTextContent('Alpha Page (2)')
    expect(groupHeaders[1]).toHaveTextContent('Beta Page (1)')
  })

  // 4. Sort blocks by ID descending within groups
  it('sorts blocks by ID descending within groups', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({ id: 'AAA', parent_id: 'PAGE1', content: 'first created' }),
        makeBlock({ id: 'CCC', parent_id: 'PAGE1', content: 'third created' }),
        makeBlock({ id: 'BBB', parent_id: 'PAGE1', content: 'second created' }),
      ],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Test Page', block_type: 'page', deleted: false },
    ])

    render(<DonePanel date="2025-06-15" />)

    await screen.findByText('3 Completed')

    // Blocks should be sorted by ID descending: CCC > BBB > AAA
    const items = screen.getAllByText(/first created|second created|third created/)
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('third created')
    expect(items[1]).toHaveTextContent('second created')
    expect(items[2]).toHaveTextContent('first created')
  })

  // 5. Shows loading skeleton during initial load
  it('shows loading skeleton during initial load', async () => {
    // Never-resolving promise to keep loading state
    mockedQueryByProperty.mockImplementation(() => new Promise(() => {}))

    const { container } = render(<DonePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
      expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
    })
  })

  // 6. Shows source page breadcrumb from batchResolve
  it('shows source page breadcrumb from batchResolve', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1' })],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'My Page Title', block_type: 'page', deleted: false },
    ])

    render(<DonePanel date="2025-06-15" />)

    expect(await screen.findByText('→ My Page Title')).toBeInTheDocument()
  })

  // 7. Click navigates to source page
  it('click navigates to source page', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'BLOCK_1', parent_id: 'PAGE1', content: 'click me' })],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Source Page', block_type: 'page', deleted: false },
    ])

    render(<DonePanel date="2025-06-15" onNavigateToPage={onNavigate} />)

    const blockItem = await screen.findByText('click me')
    const li = blockItem.closest('li') as HTMLElement
    await user.click(li)

    expect(onNavigate).toHaveBeenCalledWith('PAGE1', 'Source Page', 'BLOCK_1')
  })

  // 8. Shows check icon per block
  it('shows check icon per block', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', content: 'done task one' }),
        makeBlock({ id: 'B2', content: 'done task two' }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<DonePanel date="2025-06-15" />)

    await screen.findByText('2 Completed')

    const checkIcons = screen.getAllByTestId('check-circle')
    expect(checkIcons).toHaveLength(2)
  })

  // 9. "Load more" button when hasMore=true
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
    mockedQueryByProperty.mockImplementation(async () => {
      callCount++
      return callCount === 1 ? page1 : page2
    })

    render(<DonePanel date="2025-06-15" />)

    const loadMoreBtn = await screen.findByRole('button', {
      name: /load more completed items/i,
    })
    expect(loadMoreBtn).toBeInTheDocument()

    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedQueryByProperty).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'cursor_page2' }),
      )
    })
  })

  // 9b. Hides load more when no more
  it('hides load more when no more', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'only block' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DonePanel date="2025-06-15" />)

    await screen.findByText('only block')

    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  // 10. Collapse/expand toggle works
  it('collapse/expand toggle works', async () => {
    const user = userEvent.setup()
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B1', content: 'visible block' })],
      next_cursor: null,
      has_more: false,
    })

    render(<DonePanel date="2025-06-15" />)

    // Content should be visible (expanded by default)
    expect(await screen.findByText('visible block')).toBeInTheDocument()

    const section = screen.getByLabelText('Completed items')
    expect(section.querySelector('.done-panel-content')).toBeInTheDocument()

    // Click header to collapse
    const header = screen.getByText('1 Completed')
    await user.click(header)

    // Content should be hidden
    expect(section.querySelector('.done-panel-content')).not.toBeInTheDocument()

    // Click header to expand again
    await user.click(header)

    // Content should be visible again
    expect(section.querySelector('.done-panel-content')).toBeInTheDocument()
  })

  // 11. Re-fetches on date prop change
  it('re-fetches on date prop change', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
    })

    const { rerender } = render(<DonePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(mockedQueryByProperty).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'completed_at', valueDate: '2025-06-15' }),
      )
    })

    mockedQueryByProperty.mockClear()
    mockedBatchResolve.mockClear()

    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B2' })],
      next_cursor: null,
      has_more: false,
    })

    rerender(<DonePanel date="2025-06-16" />)

    await waitFor(() => {
      expect(mockedQueryByProperty).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'completed_at', valueDate: '2025-06-16' }),
      )
    })
  })

  // 12. A11y audit passes (axe)
  it('a11y: no violations', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B1', todo_state: 'DONE', content: 'accessible block' })],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Page Title', block_type: 'page', deleted: false },
    ])

    const { container } = render(<DonePanel date="2025-06-15" />)

    await screen.findByText('accessible block')

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ---------------------------------------------------------------------------
  // Group header page title navigation (#UX-H11)
  // ---------------------------------------------------------------------------

  // 13. clicking page title in group header navigates to that page
  it('clicking page title in group header navigates to that page', async () => {
    const user = userEvent.setup()
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1', content: 'done task' })],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'My Project', block_type: 'page', deleted: false },
    ])

    render(<DonePanel date="2025-06-15" />)

    // Wait for group to render — PageLink renders title as a button
    const pageLink = await screen.findByTestId('page-link-PAGE1')
    expect(pageLink).toHaveTextContent('My Project')

    await user.click(pageLink)

    expect(mockNavigateToPage).toHaveBeenCalledWith('PAGE1', 'My Project')
  })

  // ---------------------------------------------------------------------------
  // Error-path tests
  // ---------------------------------------------------------------------------

  // 14. queryByProperty rejects on initial load → renders nothing + logs error (UX-124, UX-130)
  it('renders nothing when queryByProperty rejects on initial load', async () => {
    mockedQueryByProperty.mockRejectedValueOnce(new Error('backend error'))

    const { container } = render(<DonePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(mockedQueryByProperty).toHaveBeenCalled()
    })

    // UX-130: component returns null when empty (even on error)
    await waitFor(() => {
      expect(container.querySelector('.done-panel')).not.toBeInTheDocument()
    })
    // UX-124: logger.error should have been called
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'DonePanel',
      'Failed to load done items',
      undefined,
      expect.any(Error),
    )
    // batchResolve should not have been called since queryByProperty failed first
    expect(mockedBatchResolve).not.toHaveBeenCalled()
  })

  // 15. batchResolve rejects on initial load → blocks shown with Untitled group header
  it('shows blocks with Untitled group when batchResolve rejects on initial load', async () => {
    mockedQueryByProperty.mockResolvedValueOnce({
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1', content: 'done task' })],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockRejectedValueOnce(new Error('resolve error'))

    render(<DonePanel date="2025-06-15" />)

    // Block should be visible (setBlocks was called before batchResolve)
    expect(await screen.findByText('done task')).toBeInTheDocument()

    // Group header should show "Untitled" because batchResolve failed
    await waitFor(() => {
      const groupHeaders = document.querySelectorAll('.done-panel-group-header')
      expect(groupHeaders).toHaveLength(1)
      expect(groupHeaders[0]).toHaveTextContent('Untitled (1)')
    })
  })

  // 16. queryByProperty rejects on load more → existing blocks preserved
  it('preserves existing blocks when queryByProperty rejects on load more', async () => {
    const user = userEvent.setup()

    mockedQueryByProperty
      .mockResolvedValueOnce({
        items: [makeBlock({ id: 'B1', content: 'existing block' })],
        next_cursor: 'cursor_2',
        has_more: true,
      })
      .mockRejectedValueOnce(new Error('network error'))

    render(<DonePanel date="2025-06-15" />)

    const loadMoreBtn = await screen.findByRole('button', {
      name: /load more completed items/i,
    })

    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedQueryByProperty).toHaveBeenCalledTimes(2)
    })

    // Existing block should still be visible
    expect(screen.getByText('existing block')).toBeInTheDocument()
    // Header still shows correct count from initial load
    expect(screen.getByText('1 Completed')).toBeInTheDocument()
  })

  // 17. batchResolve rejects on load more → new blocks added, old titles preserved
  it('shows new blocks with Untitled when batchResolve rejects on load more', async () => {
    const user = userEvent.setup()

    mockedQueryByProperty
      .mockResolvedValueOnce({
        items: [makeBlock({ id: 'B1', parent_id: 'PAGE1', content: 'first block' })],
        next_cursor: 'cursor_2',
        has_more: true,
      })
      .mockResolvedValueOnce({
        items: [makeBlock({ id: 'B2', parent_id: 'PAGE2', content: 'second block' })],
        next_cursor: null,
        has_more: false,
      })
    mockedBatchResolve
      .mockResolvedValueOnce([
        { id: 'PAGE1', title: 'Resolved Page', block_type: 'page', deleted: false },
      ])
      .mockRejectedValueOnce(new Error('resolve error'))

    render(<DonePanel date="2025-06-15" />)

    await screen.findByText('first block')

    const loadMoreBtn = screen.getByRole('button', {
      name: /load more completed items/i,
    })
    await user.click(loadMoreBtn)

    // Both blocks should be visible
    await waitFor(() => {
      expect(screen.getByText('first block')).toBeInTheDocument()
      expect(screen.getByText('second block')).toBeInTheDocument()
    })

    // PAGE1 group still has its resolved title from initial load
    const section = screen.getByLabelText('Completed items')
    const groupHeaders = section.querySelectorAll('.done-panel-group-header')
    expect(groupHeaders).toHaveLength(2)
    // Groups sorted alphabetically: "Resolved Page" < "Untitled"
    expect(groupHeaders[0]).toHaveTextContent('Resolved Page (1)')
    expect(groupHeaders[1]).toHaveTextContent('Untitled (1)')
  })

  // 18. Does not render blocks with empty content (UX-129)
  it('does not render blocks with empty content', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', content: 'real done task' }),
        makeBlock({ id: 'B2', content: null }),
        makeBlock({ id: 'B3', content: '' }),
        makeBlock({ id: 'B4', content: '   ' }),
        makeBlock({ id: 'B5', content: 'another done task' }),
      ],
      next_cursor: null,
      has_more: false,
    })

    render(<DonePanel date="2025-06-15" />)

    // Only the 2 non-empty blocks should render
    expect(await screen.findByText('2 Completed')).toBeInTheDocument()
    expect(screen.getByText('real done task')).toBeInTheDocument()
    expect(screen.getByText('another done task')).toBeInTheDocument()

    // Empty / whitespace blocks should not appear
    expect(screen.queryByText('(empty)')).not.toBeInTheDocument()
  })

  // 19. Excludes blocks whose parent_id matches excludePageId (B-74)
  it('excludes blocks whose parent_id matches excludePageId', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', parent_id: 'PAGE_1', content: 'same-page task' }),
        makeBlock({ id: 'B2', parent_id: 'PAGE_2', content: 'other-page task' }),
        makeBlock({ id: 'B3', parent_id: 'PAGE_3', content: 'third-page task' }),
      ],
      next_cursor: null,
      has_more: false,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE_2', title: 'Other Page', block_type: 'page', deleted: false },
      { id: 'PAGE_3', title: 'Third Page', block_type: 'page', deleted: false },
    ])

    render(<DonePanel date="2026-04-13" excludePageId="PAGE_1" />)

    // Only the 2 non-excluded blocks should render
    expect(await screen.findByText('2 Completed')).toBeInTheDocument()
    expect(screen.getByText('other-page task')).toBeInTheDocument()
    expect(screen.getByText('third-page task')).toBeInTheDocument()

    // The excluded block should NOT appear
    expect(screen.queryByText('same-page task')).not.toBeInTheDocument()
  })
})
