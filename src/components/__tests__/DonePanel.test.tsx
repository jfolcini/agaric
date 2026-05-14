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
import { t } from '@/lib/i18n'

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

vi.mock('../RichContentRenderer', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

vi.mock('../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
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

import { makeBlock } from '../../__tests__/fixtures'
import { logger } from '../../lib/logger'
import { batchResolve, queryByProperty } from '../../lib/tauri'
import { DonePanel } from '../DonePanel'

const mockedQueryByProperty = vi.mocked(queryByProperty)
const mockedBatchResolve = vi.mocked(batchResolve)

const emptyResponse = {
  items: [],
  next_cursor: null,
  has_more: false,
  total_count: null,
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
      total_count: null,
    })

    render(<DonePanel date="2025-06-15" />)

    expect(await screen.findByText(t('donePanel.header', { count: 3 }))).toBeInTheDocument()
  })

  // 1b. Singular count
  it('renders singular count header ("1 Completed")', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [makeBlock({ id: 'B1' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DonePanel date="2025-06-15" />)

    expect(await screen.findByText(t('donePanel.headerOne'))).toBeInTheDocument()
  })

  // 2. UX empty-state mandate: renders EmptyState (not `return null`) when
  // the panel has no items, so the user sees *why* it's empty.
  it('renders EmptyState when no items', async () => {
    mockedQueryByProperty.mockResolvedValue(emptyResponse)

    const { container } = render(<DonePanel date="2025-06-15" />)

    // Wait for loading → empty transition. React 19 flushes this on a
    // later microtask, so wait on the observable end state rather than
    // on the IPC call alone.
    await waitFor(() => {
      expect(container.querySelector('.done-panel')).toBeInTheDocument()
    })
    expect(mockedQueryByProperty).toHaveBeenCalled()
    // EmptyState renders the i18n message so the user knows why the panel
    // is empty (UX/AGENTS empty-state mandate).
    expect(screen.getByText(t('donePanel.noneYet'))).toBeInTheDocument()
  })

  // 3. Groups by source page with page titles
  it('groups blocks by source page with page titles', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'block in alpha' }),
        makeBlock({ id: 'B2', parent_id: 'PAGE2', page_id: 'PAGE2', content: 'block in beta' }),
        makeBlock({ id: 'B3', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'another in alpha' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Alpha Page', block_type: 'page', deleted: false },
      { id: 'PAGE2', title: 'Beta Page', block_type: 'page', deleted: false },
    ])

    render(<DonePanel date="2025-06-15" />)

    await screen.findByText(t('donePanel.header', { count: 3 }))

    // Group headers should show page titles with counts, sorted alphabetically
    const section = screen.getByLabelText(t('donePanel.completedItems'))
    const groupHeaders = section.querySelectorAll('.done-panel-group-header')
    expect(groupHeaders).toHaveLength(2)
    expect(groupHeaders[0]).toHaveTextContent('Alpha Page (2)')
    expect(groupHeaders[1]).toHaveTextContent('Beta Page (1)')
  })

  // 4. Sort blocks by ID descending within groups
  it('sorts blocks by ID descending within groups', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({ id: 'AAA', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'first created' }),
        makeBlock({ id: 'CCC', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'third created' }),
        makeBlock({ id: 'BBB', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'second created' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE1', title: 'Test Page', block_type: 'page', deleted: false },
    ])

    render(<DonePanel date="2025-06-15" />)

    await screen.findByText(t('donePanel.header', { count: 3 }))

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
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1', page_id: 'PAGE1' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
      total_count: null,
    })

    render(<DonePanel date="2025-06-15" />)

    await screen.findByText(t('donePanel.header', { count: 2 }))

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
      total_count: null,
    }
    const page2 = {
      items: [makeBlock({ id: 'B2', content: 'second block' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
      total_count: null,
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
      total_count: null,
    })

    render(<DonePanel date="2025-06-15" />)

    // Content should be visible (expanded by default)
    expect(await screen.findByText('visible block')).toBeInTheDocument()

    const section = screen.getByLabelText(t('donePanel.completedItems'))
    expect(section.querySelector('.done-panel-content')).toBeInTheDocument()

    // Click header to collapse
    const header = screen.getByText(t('donePanel.headerOne'))
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
      total_count: null,
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
      total_count: null,
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
      total_count: null,
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
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'done task' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
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

  // 14. queryByProperty rejects on initial load → renders EmptyState + logs error (UX-124, UX-130)
  it('renders EmptyState when queryByProperty rejects on initial load', async () => {
    mockedQueryByProperty.mockRejectedValueOnce(new Error('backend error'))

    const { container } = render(<DonePanel date="2025-06-15" />)

    await waitFor(() => {
      expect(mockedQueryByProperty).toHaveBeenCalled()
    })

    // UX-130 / empty-state mandate: component renders EmptyState when
    // empty (even on error), so the user knows why the panel is bare.
    await waitFor(() => {
      expect(container.querySelector('.done-panel')).toBeInTheDocument()
    })
    expect(screen.getByText(t('donePanel.noneYet'))).toBeInTheDocument()
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
      items: [makeBlock({ id: 'B1', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'done task' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockRejectedValueOnce(new Error('resolve error'))

    render(<DonePanel date="2025-06-15" />)

    // Block should be visible (setBlocks was called before batchResolve)
    expect(await screen.findByText('done task')).toBeInTheDocument()

    // Group header should show "Untitled" because batchResolve failed
    await waitFor(() => {
      const groupHeaders = document.querySelectorAll('.done-panel-group-header')
      expect(groupHeaders).toHaveLength(1)
      expect(groupHeaders[0]).toHaveTextContent(`${t('donePanel.untitled')} (1)`)
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
        total_count: null,
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
    expect(screen.getByText(t('donePanel.headerOne'))).toBeInTheDocument()
  })

  // 17. batchResolve rejects on load more → new blocks added, old titles preserved
  it('shows new blocks with Untitled when batchResolve rejects on load more', async () => {
    const user = userEvent.setup()

    mockedQueryByProperty
      .mockResolvedValueOnce({
        items: [
          makeBlock({ id: 'B1', parent_id: 'PAGE1', page_id: 'PAGE1', content: 'first block' }),
        ],
        next_cursor: 'cursor_2',
        has_more: true,
        total_count: null,
      })
      .mockResolvedValueOnce({
        items: [
          makeBlock({ id: 'B2', parent_id: 'PAGE2', page_id: 'PAGE2', content: 'second block' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
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
    const section = screen.getByLabelText(t('donePanel.completedItems'))
    const groupHeaders = section.querySelectorAll('.done-panel-group-header')
    expect(groupHeaders).toHaveLength(2)
    // Groups sorted alphabetically: "Resolved Page" < "Untitled"
    expect(groupHeaders[0]).toHaveTextContent('Resolved Page (1)')
    expect(groupHeaders[1]).toHaveTextContent(`${t('donePanel.untitled')} (1)`)
  })

  // 18. PEND-35 Tier 1.5 — empty-content rejection lives in the backend
  // now. The panel must pass `contentNonEmpty: true` on every fetch so
  // the backend can drop those rows server-side; cursor accounting and
  // totalCount then reflect the post-filter set authoritatively.
  it('passes contentNonEmpty: true so the backend filters empty content (UX-129)', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        // Mock returns whatever the test wants; the FE no longer
        // post-filters, so the displayed count matches what the
        // backend returned.
        makeBlock({ id: 'B1', content: 'real done task' }),
        makeBlock({ id: 'B2', content: 'another done task' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DonePanel date="2025-06-15" />)

    expect(await screen.findByText(t('donePanel.header', { count: 2 }))).toBeInTheDocument()
    expect(mockedQueryByProperty).toHaveBeenCalledWith(
      expect.objectContaining({ contentNonEmpty: true }),
    )
  })

  // 19. PEND-35 Tier 1.5 — excludePageId is forwarded as
  // `excludeParentId` to the backend. Cursor pagination, has_more,
  // and totalCount now reflect the post-filter set authoritatively.
  it('forwards excludePageId as excludeParentId to the backend (B-74)', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({ id: 'B2', parent_id: 'PAGE_2', page_id: 'PAGE_2', content: 'other-page task' }),
        makeBlock({ id: 'B3', parent_id: 'PAGE_3', page_id: 'PAGE_3', content: 'third-page task' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    mockedBatchResolve.mockResolvedValue([
      { id: 'PAGE_2', title: 'Other Page', block_type: 'page', deleted: false },
      { id: 'PAGE_3', title: 'Third Page', block_type: 'page', deleted: false },
    ])

    render(<DonePanel date="2026-04-13" excludePageId="PAGE_1" />)

    expect(await screen.findByText(t('donePanel.header', { count: 2 }))).toBeInTheDocument()
    expect(mockedQueryByProperty).toHaveBeenCalledWith(
      expect.objectContaining({ excludeParentId: 'PAGE_1', contentNonEmpty: true }),
    )
  })

  // 20. PEND-35 Tier 1.5 — totalCount reflects the backend response
  // size, not a post-filter remainder. Pinning this prevents a
  // future regression where the FE re-introduces a post-filter that
  // would silently desync `totalCount` from `hasMore`.
  it('totalCount reflects backend response size (no FE post-filter)', async () => {
    mockedQueryByProperty.mockResolvedValue({
      items: [
        makeBlock({ id: 'B1', content: 'task one' }),
        makeBlock({ id: 'B2', content: 'task two' }),
        makeBlock({ id: 'B3', content: 'task three' }),
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<DonePanel date="2025-06-15" excludePageId="PAGE_X" />)

    // Header reflects the 3 items the backend returned, even though a
    // pre-PEND-35 build would have post-filtered some out.
    expect(await screen.findByText(t('donePanel.header', { count: 3 }))).toBeInTheDocument()
  })
})
