/**
 * Tests for UnlinkedReferences component (#577, #578, #579).
 *
 * Validates:
 *  1. Renders collapsed by default
 *  2. Shows total count in header
 *  3. Expands on header click (lazy fetch)
 *  4. Renders groups with page titles
 *  5. Renders block content in each group
 *  6. "Link it" calls editBlock with correct content
 *  7. "Link it" removes block from list
 *  8. "Link it" case-insensitive match
 *  9. Load more fetches next page
 *  10. Resets on pageId change
 *  11. Shows "No Unlinked References" when totalCount is 0
 *  12. A11y audit passes
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'

vi.mock('../../lib/tauri', () => ({
  listUnlinkedReferences: vi.fn(),
  editBlock: vi.fn(),
  listTagsByPrefix: vi.fn(),
  listPropertyKeys: vi.fn(),
}))

vi.mock('lucide-react', () => ({
  ChevronRight: (props: Record<string, unknown>) => <svg data-testid="chevron-right" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <svg data-testid="chevron-down" {...props} />,
  Link2: (props: Record<string, unknown>) => <svg data-testid="link2-icon" {...props} />,
  Loader2: (props: Record<string, unknown>) => <svg data-testid="loader2-icon" {...props} />,
  SlidersHorizontal: (props: Record<string, unknown>) => (
    <svg data-testid="sliders-horizontal-icon" {...props} />
  ),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('../BacklinkFilterBuilder', () => ({
  BacklinkFilterBuilder: () => <div data-testid="backlink-filter-builder">Advanced Filters</div>,
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

import {
  editBlock,
  listPropertyKeys,
  listTagsByPrefix,
  listUnlinkedReferences,
} from '../../lib/tauri'
import { UnlinkedReferences } from '../UnlinkedReferences'
import { TooltipProvider } from '../ui/tooltip'

const mockedListUnlinked = vi.mocked(listUnlinkedReferences)
const mockedEditBlock = vi.mocked(editBlock)
const mockedListTagsByPrefix = vi.mocked(listTagsByPrefix)
const mockedListPropertyKeys = vi.mocked(listPropertyKeys)

function makeGroup(
  pageId: string,
  pageTitle: string | null,
  blocks: Array<{ id: string; content: string }>,
) {
  return {
    page_id: pageId,
    page_title: pageTitle,
    blocks: blocks.map((b) => ({
      id: b.id,
      block_type: 'content' as const,
      content: b.content,
      parent_id: pageId,
      position: 1,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    })),
  }
}

const emptyResponse = {
  groups: [],
  next_cursor: null,
  has_more: false,
  total_count: 0,
  filtered_count: 0,
  truncated: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockNavigateToPage.mockClear()
  mockedListUnlinked.mockResolvedValue(emptyResponse)
  mockedEditBlock.mockResolvedValue({
    id: 'BLOCK',
    block_type: 'content',
    content: '',
    parent_id: 'P1',
    position: 0,
    deleted_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
  })
  mockedListTagsByPrefix.mockResolvedValue([])
  mockedListPropertyKeys.mockResolvedValue([])
})

/** Wrap UnlinkedReferences in TooltipProvider (required for UX-168 filter icon button). */
function renderUnlinkedReferences(props: {
  pageId: string
  pageTitle: string
  onNavigateToPage?: typeof mockNavigateToPage
}) {
  return render(
    <TooltipProvider>
      <UnlinkedReferences {...props} />
    </TooltipProvider>,
  )
}

describe('UnlinkedReferences', () => {
  // 1. Renders collapsed by default (with results present)
  it('renders collapsed by default — header visible, content not visible', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Wait for eager fetch to complete
    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalled()
    })

    // Header should be present and collapsed
    const header = await screen.findByRole('button', { name: /unlinked reference/i })
    expect(header).toBeInTheDocument()
    expect(header).toHaveAttribute('aria-expanded', 'false')

    // Content should NOT be visible (collapsed)
    expect(document.querySelector('.unlinked-references-content')).not.toBeInTheDocument()
  })

  // 2. Shows total count in header after expanding
  it('shows total count in header', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [
          { id: 'B1', content: 'hello my page world' },
          { id: 'B2', content: 'another my page mention' },
        ]),
        makeGroup('P2', 'Page Two', [
          { id: 'B3', content: 'third my page' },
          { id: 'B4', content: 'fourth my page' },
          { id: 'B5', content: 'fifth my page' },
        ]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 5,
      filtered_count: 5,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Click to expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    expect(await screen.findByText('5 Unlinked References')).toBeInTheDocument()
  })

  // 3. Expands on header click — groups become visible, listUnlinkedReferences called
  it('expands on header click', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Source Page', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    const header = screen.getByRole('button', { name: /unlinked references/i })

    // Initially collapsed
    expect(header).toHaveAttribute('aria-expanded', 'false')

    // Click to expand
    await user.click(header)

    // Should call the API
    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalledWith({
        pageId: 'PAGE1',
        cursor: null,
        limit: 20,
      })
    })

    // Header now expanded
    expect(header).toHaveAttribute('aria-expanded', 'true')

    // Groups should be visible
    expect(await screen.findByText('Source Page (1)')).toBeInTheDocument()
  })

  // 4. Renders groups with page titles and block counts
  it('renders groups with page titles', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [
        makeGroup('P1', 'Alpha Page', [
          { id: 'B1', content: 'block 1' },
          { id: 'B2', content: 'block 2' },
        ]),
        makeGroup('P2', 'Beta Page', [{ id: 'B3', content: 'block 3' }]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 3,
      filtered_count: 3,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    expect(await screen.findByText('Alpha Page (2)')).toBeInTheDocument()
    expect(screen.getByText('Beta Page (1)')).toBeInTheDocument()
  })

  // 5. Renders block content in each group
  it('renders block content in each group', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [
          { id: 'B1', content: 'first block content' },
          { id: 'B2', content: 'second block content' },
        ]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    expect(await screen.findByText('first block content')).toBeInTheDocument()
    expect(screen.getByText('second block content')).toBeInTheDocument()
  })

  // 6. "Link it" button calls editBlock with correct content
  it('"Link it" calls editBlock with correct content', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'I mention My Page here' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    // Wait for content
    await screen.findByText('I mention My Page here')

    // Click "Link it"
    const linkItBtn = screen.getByRole('button', { name: /link it/i })
    await user.click(linkItBtn)

    expect(mockedEditBlock).toHaveBeenCalledWith('B1', 'I mention [[PAGE1]] here')
  })

  // 7. "Link it" removes block from list
  it('"Link it" removes block from list after successful edit', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [
          { id: 'B1', content: 'first My Page ref' },
          { id: 'B2', content: 'second My Page ref' },
        ]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    await screen.findByText('first My Page ref')
    expect(screen.getByText('second My Page ref')).toBeInTheDocument()

    // Click the first "Link it" button
    const linkItBtns = screen.getAllByRole('button', { name: /link it/i })
    await user.click(linkItBtns[0] as HTMLElement)

    // First block should be removed
    await waitFor(() => {
      expect(screen.queryByText('first My Page ref')).not.toBeInTheDocument()
    })

    // Second block should still be there
    expect(screen.getByText('second My Page ref')).toBeInTheDocument()

    // Count should decrease
    expect(screen.getByText('1 Unlinked Reference')).toBeInTheDocument()
  })

  // 8. "Link it" case-insensitive match
  it('"Link it" handles case-insensitive match', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [{ id: 'B1', content: 'I mention my page in lowercase' }]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('I mention my page in lowercase')

    const linkItBtn = screen.getByRole('button', { name: /link it/i })
    await user.click(linkItBtn)

    // Should replace the case-insensitive match
    expect(mockedEditBlock).toHaveBeenCalledWith('B1', 'I mention [[PAGE1]] in lowercase')
  })

  // 9. Load more button fetches next page
  it('load more button fetches next page', async () => {
    const user = userEvent.setup()
    const page1 = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    const page2 = {
      groups: [makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'block 2' }])],
      next_cursor: null,
      has_more: false,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    let callCount = 0
    mockedListUnlinked.mockImplementation(async () => {
      callCount++
      return callCount === 1 ? page1 : page2
    })

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    // Wait for first page
    await screen.findByText('block 1')

    // "Load more" should be visible
    const loadMoreBtn = screen.getByRole('button', { name: /load more unlinked references/i })
    expect(loadMoreBtn).toBeInTheDocument()

    // Click load more
    await user.click(loadMoreBtn)

    // Should have called with cursor
    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalledWith({
        pageId: 'PAGE1',
        cursor: 'cursor_page2',
        limit: 20,
      })
    })

    // Both groups should be rendered
    expect(await screen.findByText('block 2')).toBeInTheDocument()
    expect(screen.getByText('block 1')).toBeInTheDocument()
  })

  // 10. Resets on pageId change
  it('resets on pageId change', async () => {
    const user = userEvent.setup()
    const resp1 = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'page 1 block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp1)

    const { rerender } = renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('page 1 block')

    // Clear mocks
    mockedListUnlinked.mockClear()

    const resp2 = {
      groups: [makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'page 2 block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp2)

    // Re-render with new pageId — component should collapse back
    rerender(
      <TooltipProvider>
        <UnlinkedReferences pageId="PAGE2" pageTitle="Other Page" />
      </TooltipProvider>,
    )

    // Should be collapsed again after pageId change
    const header = screen.getByRole('button', { name: /unlinked references/i })
    expect(header).toHaveAttribute('aria-expanded', 'false')

    // Expand again to trigger new fetch
    await user.click(header)

    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalledWith({
        pageId: 'PAGE2',
        cursor: null,
        limit: 20,
      })
    })
  })

  // 11. UX-152: Returns null when totalCount is 0
  it('returns null when no unlinked references', async () => {
    mockedListUnlinked.mockResolvedValue(emptyResponse)

    const { container } = renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Wait for eager fetch to complete
    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalled()
    })

    // Component should return null — no section, no header, nothing
    await waitFor(() => {
      expect(container.querySelector('.unlinked-references')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('No Unlinked References')).not.toBeInTheDocument()
    expect(screen.queryByText('No unlinked references found.')).not.toBeInTheDocument()
  })

  // 11b. Shows loading indicator when expanding and fetching
  it('shows loading indicator when fetching after expand', async () => {
    const user = userEvent.setup()
    // Never-resolving promise to keep loading state
    mockedListUnlinked.mockImplementation(() => new Promise(() => {}))

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand to trigger fetch
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    // ListViewState shows skeleton (spinner) when loading with empty items
    await waitFor(() => {
      expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument()
      expect(document.querySelector('[role="status"]')).toBeInTheDocument()
    })
  })

  // 12. A11y audit passes
  it('a11y: no violations', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'accessible block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    const { container } = renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('accessible block')

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // Bonus: group toggle collapses/expands blocks
  it('group toggle collapses/expands blocks', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'visible block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand main section
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    expect(await screen.findByText('visible block')).toBeInTheDocument()

    // Click group header to collapse
    const groupHeader = screen.getByText('Page One (1)')
    await user.click(groupHeader)

    // Block should be hidden
    expect(screen.queryByText('visible block')).not.toBeInTheDocument()

    // Click group header to expand
    await user.click(groupHeader)

    // Block should be visible again
    expect(screen.getByText('visible block')).toBeInTheDocument()
  })

  // Bonus: singular count label
  it('shows singular label for 1 reference', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'only block' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    expect(await screen.findByText('1 Unlinked Reference')).toBeInTheDocument()
  })

  it('shows error toast when editBlock fails and does not remove block', async () => {
    const { toast } = await import('sonner')
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mentions My Page here' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)
    mockedEditBlock.mockRejectedValueOnce(new Error('backend error'))

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mentions My Page here')

    await user.click(screen.getByRole('button', { name: /link it/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to link reference')
    })
    // Block should still be in the list (not removed)
    expect(screen.getByText('mentions My Page here')).toBeInTheDocument()
  })

  it('"Link it" handles special regex characters in page title', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'I love C++ coding' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)
    mockedEditBlock.mockResolvedValueOnce({
      id: 'B1',
      block_type: 'block',
      content: 'I love [[PAGE1]] coding',
      parent_id: 'P1',
      position: 0,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    })

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'C++' })
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('I love C++ coding')

    await user.click(screen.getByRole('button', { name: /link it/i }))

    expect(mockedEditBlock).toHaveBeenCalledWith('B1', 'I love [[PAGE1]] coding')
  })

  it('"Link it" replaces only first occurrence of page title', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [
        makeGroup('P1', 'Page One', [{ id: 'B1', content: 'My Page mentions My Page twice' }]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)
    mockedEditBlock.mockResolvedValueOnce({
      id: 'B1',
      block_type: 'block',
      content: '[[PAGE1]] mentions My Page twice',
      parent_id: 'P1',
      position: 0,
      deleted_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
      page_id: null,
    })

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('My Page mentions My Page twice')

    await user.click(screen.getByRole('button', { name: /link it/i }))

    // Only first occurrence replaced
    expect(mockedEditBlock).toHaveBeenCalledWith('B1', '[[PAGE1]] mentions My Page twice')
  })

  // ---------------------------------------------------------------------------
  // Group header page title navigation (#UX-H11)
  // ---------------------------------------------------------------------------

  // clicking group header page title triggers navigation
  it('clicking group header page title navigates to that page', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const resp = {
      groups: [makeGroup('P1', 'Source Page', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({
      pageId: 'PAGE1',
      pageTitle: 'My Page',
      onNavigateToPage: onNavigate,
    })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    // Wait for group to load — with onNavigateToPage, the split layout is active
    const pageLink = await screen.findByTestId('page-link-P1')
    expect(pageLink).toHaveTextContent('Source Page')

    await user.click(pageLink)

    expect(mockNavigateToPage).toHaveBeenCalledWith('P1', 'Source Page')
  })

  // ---------------------------------------------------------------------------
  // UX-168: Filter controls for unlinked references
  // ---------------------------------------------------------------------------

  // Filter button appears when expanded with results
  it('filter button appears when expanded with results (UX-168)', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    // Wait for content to appear
    await screen.findByText('mention text')

    // Filter button should be visible
    expect(screen.getByRole('button', { name: /show filters/i })).toBeInTheDocument()
  })

  // Filter button hidden when collapsed
  it('filter button hidden when collapsed (UX-168)', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Wait for eager fetch
    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalled()
    })

    // Still collapsed — filter button should NOT be visible
    expect(screen.queryByRole('button', { name: /show filters/i })).not.toBeInTheDocument()
  })

  // Filter button toggles BacklinkFilterBuilder
  it('filter button toggles filter panel (UX-168)', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')

    // Advanced filters not visible initially
    expect(screen.queryByTestId('backlink-filter-builder')).not.toBeInTheDocument()

    // Click filter button to show
    await user.click(screen.getByRole('button', { name: /show filters/i }))

    // Advanced filters now visible
    expect(screen.getByTestId('backlink-filter-builder')).toBeInTheDocument()

    // Click filter button to hide
    await user.click(screen.getByRole('button', { name: /hide filters/i }))

    // Advanced filters hidden again
    expect(screen.queryByTestId('backlink-filter-builder')).not.toBeInTheDocument()
  })

  // Filter button aria-expanded toggles correctly
  it('filter button aria-expanded toggles correctly (UX-168)', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')

    const filterBtn = screen.getByRole('button', { name: /show filters/i })
    expect(filterBtn).toHaveAttribute('aria-expanded', 'false')

    await user.click(filterBtn)

    const hideBtn = screen.getByRole('button', { name: /hide filters/i })
    expect(hideBtn).toHaveAttribute('aria-expanded', 'true')
  })

  // Filter state resets when pageId changes
  it('resets filter visibility when pageId changes (UX-168)', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    const { rerender } = renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand and open filters
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')
    await user.click(screen.getByRole('button', { name: /show filters/i }))
    expect(screen.getByTestId('backlink-filter-builder')).toBeInTheDocument()

    // Re-render with different pageId
    rerender(
      <TooltipProvider>
        <UnlinkedReferences pageId="PAGE2" pageTitle="Other Page" />
      </TooltipProvider>,
    )

    // Component should collapse, so filter builder should be gone
    await waitFor(() => {
      expect(screen.queryByTestId('backlink-filter-builder')).not.toBeInTheDocument()
    })
  })

  // Loads tags and property keys on mount
  it('loads tags and property keys on mount (UX-168)', async () => {
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    await waitFor(() => {
      expect(mockedListTagsByPrefix).toHaveBeenCalledWith({ prefix: '' })
      expect(mockedListPropertyKeys).toHaveBeenCalled()
    })
  })

  // Truncation notice
  it('shows truncation notice when response is truncated', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: true,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked reference/i }))

    expect(await screen.findByText('Results truncated — refine search')).toBeInTheDocument()
  })

  it('does not show truncation notice when response is not truncated', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked reference/i }))

    await screen.findByText('mention text')

    expect(screen.queryByText('Results truncated — refine search')).not.toBeInTheDocument()
  })

  // UX-210: keyboard nav container has correct aria-label resolved via t()
  it('keyboard nav container aria-label resolves via t() (UX-210)', async () => {
    const user = userEvent.setup()
    const resp = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B1', content: 'mention text' }])],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Expand
    await user.click(await screen.findByRole('button', { name: /unlinked reference/i }))

    await screen.findByText('mention text')

    const container = screen.getByRole('group', { name: t('unlinkedRefs.listLabel') })
    expect(container).toBeInTheDocument()
    expect(container.className).toContain('unlinked-references-list')
  })
})
