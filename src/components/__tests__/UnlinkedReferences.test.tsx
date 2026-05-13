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

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'

vi.mock('../../lib/tauri', () => ({
  listUnlinkedReferences: vi.fn(),
  editBlock: vi.fn(),
  listTagsByPrefix: vi.fn(),
  listPropertyKeys: vi.fn(),
  // PEND-36 — `handleLinkIt` now reads aliases via `getPageAliases` so
  // alias-only mentions can be rewritten. Default mock returns no
  // aliases so the legacy title-only test paths stay unaffected;
  // PEND-36-specific cases override per-test.
  getPageAliases: vi.fn(),
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
  Link2: (props: Record<string, unknown>) => <svg data-testid="link2-icon" {...props} />,
  Loader2: (props: Record<string, unknown>) => <svg data-testid="loader2-icon" {...props} />,
}))

vi.mock('../BacklinkFilterBuilder', () => ({
  BacklinkFilterBuilder: ({
    onFiltersChange,
    onSortChange,
  }: {
    onFiltersChange: (filters: unknown[]) => void
    onSortChange: (sort: unknown) => void
  }) => (
    <div data-testid="backlink-filter-builder">
      Advanced Filters
      <button
        type="button"
        data-testid="test-apply-tag-filter"
        onClick={() => onFiltersChange([{ type: 'HasTag', tag_id: 'TEST_TAG' }])}
      >
        Apply Tag Filter
      </button>
      <button type="button" data-testid="test-clear-filters" onClick={() => onFiltersChange([])}>
        Clear Filters
      </button>
      <button
        type="button"
        data-testid="test-apply-sort"
        onClick={() => onSortChange({ type: 'Created', dir: 'Desc' })}
      >
        Sort Desc
      </button>
    </div>
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

import { _resetPropertyKeysCacheForTest } from '../../hooks/usePropertyKeysCache'
import { logger } from '../../lib/logger'
import {
  editBlock,
  getPageAliases,
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
const mockedGetPageAliases = vi.mocked(getPageAliases)

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
  // MAINT-189: shared property-keys cache is module-level — flush it
  // between tests so each case fetches its own keys.
  _resetPropertyKeysCacheForTest()
  mockedListUnlinked.mockResolvedValue(emptyResponse)
  mockedEditBlock.mockResolvedValue({
    id: 'BLOCK',
    block_type: 'content',
    content: '',
    parent_id: 'P1',
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
  })
  mockedListTagsByPrefix.mockResolvedValue([])
  mockedListPropertyKeys.mockResolvedValue([])
  // PEND-36: legacy tests don't care about aliases — default to none.
  mockedGetPageAliases.mockResolvedValue([])
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
        filters: null,
        sort: null,
        cursor: null,
        limit: 20,
        spaceId: null,
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
        filters: null,
        sort: null,
        cursor: 'cursor_page2',
        limit: 20,
        spaceId: null,
      })
    })

    // Both groups should be rendered
    expect(await screen.findByText('block 2')).toBeInTheDocument()
    expect(screen.getByText('block 1')).toBeInTheDocument()
  })

  // FE-L-13: cursor-append must not mutate the prior group object.
  // The no-cursor branch does `setGroups(respGroups)`, so the page-1 response's
  // group object is the very same reference React keeps as `prev`. After a
  // cursor-append targeting the same page_id, that captured reference's
  // `.blocks` must still hold the original array (length unchanged) — otherwise
  // we are mutating shared state.
  it('cursor-append does not mutate prior group object (FE-L-13)', async () => {
    const user = userEvent.setup()
    const priorGroup = makeGroup('P1', 'Page One', [{ id: 'B1', content: 'block 1' }])
    const priorBlocks = priorGroup.blocks
    const page1 = {
      groups: [priorGroup],
      next_cursor: 'cursor_page2',
      has_more: true,
      total_count: 2,
      filtered_count: 2,
      truncated: false,
    }
    const page2 = {
      groups: [makeGroup('P1', 'Page One', [{ id: 'B2', content: 'block 2' }])],
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

    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('block 1')

    // Trigger the cursor-append branch.
    await user.click(screen.getByRole('button', { name: /load more unlinked references/i }))
    expect(await screen.findByText('block 2')).toBeInTheDocument()

    // Invariant: the captured prior group must be untouched. If the merger
    // had reassigned `existing.blocks` on the shared reference, this length
    // would now be 2 and `priorGroup.blocks` would no longer be `priorBlocks`.
    expect(priorGroup.blocks).toBe(priorBlocks)
    expect(priorGroup.blocks).toHaveLength(1)
    expect(priorGroup.blocks[0]?.id).toBe('B1')
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
        filters: null,
        sort: null,
        cursor: null,
        limit: 20,
        spaceId: null,
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
  // PEND-31: BacklinkFilterBuilder visibility
  // ---------------------------------------------------------------------------

  // BacklinkFilterBuilder hidden while collapsed (default state).
  it('BacklinkFilterBuilder hidden when collapsed (PEND-31)', async () => {
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

    // Collapsed by default — filter builder must not render.
    expect(screen.queryByTestId('backlink-filter-builder')).not.toBeInTheDocument()
    // No leftover show/hide-filters toggle exists either.
    expect(screen.queryByRole('button', { name: /show filters/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /hide filters/i })).not.toBeInTheDocument()
  })

  // BacklinkFilterBuilder visible whenever expanded — no toggle click required.
  it('BacklinkFilterBuilder visible unconditionally when expanded (PEND-31)', async () => {
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

    // Advanced filters visible immediately — no toggle click needed.
    expect(screen.getByTestId('backlink-filter-builder')).toBeInTheDocument()
  })

  // Filter builder hidden again when the panel collapses on pageId change.
  it('BacklinkFilterBuilder hides when collapsed on pageId change (PEND-31)', async () => {
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

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')
    expect(screen.getByTestId('backlink-filter-builder')).toBeInTheDocument()

    // Re-render with different pageId — component collapses again.
    rerender(
      <TooltipProvider>
        <UnlinkedReferences pageId="PAGE2" pageTitle="Other Page" />
      </TooltipProvider>,
    )

    // Filter builder should be gone (panel collapsed by default).
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

  // ---------------------------------------------------------------------------
  // BUG-44: filter + sort are forwarded to the backend IPC call
  // ---------------------------------------------------------------------------

  it('selecting a filter triggers a refetch with filters in payload (BUG-44)', async () => {
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

    // Expand — BacklinkFilterBuilder is now always visible (PEND-31).
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')
    expect(screen.getByTestId('backlink-filter-builder')).toBeInTheDocument()

    // Initial fetch had no filters
    expect(mockedListUnlinked).toHaveBeenCalledWith(
      expect.objectContaining({ filters: null, sort: null }),
    )

    mockedListUnlinked.mockClear()

    // Apply a tag filter via the mocked builder
    await user.click(screen.getByTestId('test-apply-tag-filter'))

    // Refetch should fire with the new filter list
    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalledWith({
        pageId: 'PAGE1',
        filters: [{ type: 'HasTag', tag_id: 'TEST_TAG' }],
        sort: null,
        cursor: null,
        limit: 20,
        spaceId: null,
      })
    })
  })

  it('changing sort triggers a refetch with the new sort in payload (BUG-44)', async () => {
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

    // Expand — BacklinkFilterBuilder is now always visible (PEND-31).
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')

    mockedListUnlinked.mockClear()

    // Change sort via the mocked builder
    await user.click(screen.getByTestId('test-apply-sort'))

    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalledWith({
        pageId: 'PAGE1',
        filters: null,
        sort: { type: 'Created', dir: 'Desc' },
        cursor: null,
        limit: 20,
        spaceId: null,
      })
    })
  })

  it('shows error toast when listUnlinkedReferences fetch rejects (BUG-44 error path)', async () => {
    const { toast } = await import('sonner')
    mockedListUnlinked.mockRejectedValueOnce(new Error('network boom'))

    const { container } = renderUnlinkedReferences({
      pageId: 'PAGE1',
      pageTitle: 'My Page',
    })

    await waitFor(() => {
      expect(mockedListUnlinked).toHaveBeenCalled()
    })

    // Error surfaces as a toast and the component does not crash.
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load unlinked references')
    })
    // Component returns null when totalCount=0 and no filters active — that's the
    // graceful fallback behaviour when the initial fetch fails.
    expect(container.querySelector('.unlinked-references')).not.toBeInTheDocument()
  })

  // ---------------------------------------------------------------------------
  // UX-240: Header row keeps flex-nowrap / min-w-0 layout primitives
  // ---------------------------------------------------------------------------

  it('outer header row and children carry flex-nowrap / min-w-0 (UX-240)', async () => {
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

    const { container } = renderUnlinkedReferences({
      pageId: 'PAGE1',
      pageTitle: 'My Page',
    })

    // Expand to render the full header layout (badge, etc.).
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')

    const headerButton = container.querySelector('.unlinked-references-header')
    expect(headerButton).toBeInTheDocument()
    const outerRow = headerButton?.parentElement
    expect(outerRow).toBeInTheDocument()
    expect(outerRow).toHaveClass('flex', 'flex-nowrap', 'items-center', 'gap-1', 'min-w-0')

    // The header button itself must allow flex shrinking.
    expect(headerButton).toHaveClass('min-w-0')
    // But still render full-width as a click target.
    expect(headerButton).toHaveClass('w-full')
  })

  // ---------------------------------------------------------------------------
  // UX-271: "Unlinked" section badge + active-filter count badge
  // ---------------------------------------------------------------------------

  it('renders "Unlinked" section badge once expanded (UX-271)', async () => {
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

    const { container } = renderUnlinkedReferences({
      pageId: 'PAGE1',
      pageTitle: 'My Page',
    })

    // Collapsed by default — badge not visible.
    expect(container.querySelector('.unlinked-references-link-type-badge')).toBeNull()

    // Expand to reveal results and the badge.
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')

    const badge = container.querySelector('.unlinked-references-link-type-badge')
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent('Unlinked')
  })

  it('does not render filter count badge when no filters are active (UX-271)', async () => {
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

    const { container } = renderUnlinkedReferences({
      pageId: 'PAGE1',
      pageTitle: 'My Page',
    })

    // Expand — BacklinkFilterBuilder is now always visible (PEND-31).
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')

    // No filter applied yet, so the count badge stays hidden.
    expect(container.querySelector('.unlinked-references-filter-count')).toBeNull()
  })

  it('renders filter count badge with active filter count (UX-271)', async () => {
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

    const { container } = renderUnlinkedReferences({
      pageId: 'PAGE1',
      pageTitle: 'My Page',
    })

    // Expand — BacklinkFilterBuilder is now always visible (PEND-31).
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')

    // Apply a filter via the always-visible builder.
    await user.click(screen.getByTestId('test-apply-tag-filter'))

    const badge = await waitFor(() => {
      const el = container.querySelector('.unlinked-references-filter-count')
      if (!el) throw new Error('badge not found yet')
      return el
    })
    expect(badge).toHaveTextContent('1')
    expect(badge).toHaveAttribute('aria-label', '1 filter applied')
  })

  it('hides filter count badge after filters are cleared (UX-271)', async () => {
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

    const { container } = renderUnlinkedReferences({
      pageId: 'PAGE1',
      pageTitle: 'My Page',
    })

    // Expand — BacklinkFilterBuilder is now always visible (PEND-31).
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('mention text')

    await user.click(screen.getByTestId('test-apply-tag-filter'))

    await waitFor(() => {
      expect(container.querySelector('.unlinked-references-filter-count')).not.toBeNull()
    })

    await user.click(screen.getByTestId('test-clear-filters'))

    await waitFor(() => {
      expect(container.querySelector('.unlinked-references-filter-count')).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // PEND-29 B-6: cancellation flag on the mount-once `listTagsByPrefix` effect
  // ---------------------------------------------------------------------------

  it('cancels the listTagsByPrefix promise on unmount (PEND-29 B-6)', async () => {
    let rejectTags!: (err: unknown) => void
    mockedListTagsByPrefix.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectTags = reject
        }),
    )

    const { unmount } = renderUnlinkedReferences({ pageId: 'PAGE1', pageTitle: 'My Page' })

    // Wait until the mount-once effect has fired the IPC call.
    await waitFor(() => {
      expect(mockedListTagsByPrefix).toHaveBeenCalled()
    })

    // Unmount before the promise settles — cleanup sets cancelled=true.
    unmount()

    // Reject the still-pending promise post-unmount and let the
    // microtask chain settle inside an `act(async)` boundary so React
    // would surface any setState-on-unmounted warning.
    await act(async () => {
      rejectTags(new Error('post-unmount rejection'))
    })

    // Cancellation flag short-circuits the catch — no logger.error is
    // emitted for the dead component.
    expect(vi.mocked(logger.error)).not.toHaveBeenCalledWith(
      'UnlinkedReferences',
      'Failed to load tags',
      undefined,
      expect.any(Error),
    )
  })

  // ── PEND-36: alias fallback in handleLinkIt ──────────────────────────────
  //
  // The backend's `eval_unlinked_references` OR-joins the page title and
  // its aliases into the FTS5 query, so a block whose content mentions
  // ONLY an alias still surfaces here. Pre-PEND-36 the FE's
  // `handleLinkIt` compiled `new RegExp(escapeRegExp(pageTitle))` and
  // silently no-op'd on alias-only matches while the optimistic UI told
  // the user "linked" — see `pending/PEND-36-...` for the full diagnosis.
  // The four cases below pin: alias-only match rewrites, title takes
  // priority when both present, the no-match guard surfaces a toast and
  // skips the optimistic removal, and aliases follow the page when
  // `pageId` changes.

  it('"Link it" rewrites an alias-only mention into [[pageId]] (PEND-36)', async () => {
    const user = userEvent.setup()
    mockedGetPageAliases.mockResolvedValue(['ProjAlpha'])
    const resp = {
      groups: [
        makeGroup('SOURCE', 'Source Page', [
          { id: 'B_ALIAS', content: 'See ProjAlpha for more info' },
        ]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE_ALPHA', pageTitle: 'Project Alpha' })

    await user.click(await screen.findByRole('button', { name: /unlinked references/i }))

    // Wait for aliases load + the block to render.
    await waitFor(() => {
      expect(mockedGetPageAliases).toHaveBeenCalledWith('PAGE_ALPHA')
    })

    const linkBtn = await screen.findByRole('button', {
      name: /Link it: replace mention in block B_ALIAS/i,
    })
    await user.click(linkBtn)

    await waitFor(() => {
      expect(mockedEditBlock).toHaveBeenCalledWith('B_ALIAS', 'See [[PAGE_ALPHA]] for more info')
    })
  })

  it('"Link it" prefers the canonical title when content matches both (PEND-36)', async () => {
    // Title takes priority — the user gave the page that name, the
    // alias is secondary. If both appear in the content, the title
    // mention is the one that gets converted.
    const user = userEvent.setup()
    mockedGetPageAliases.mockResolvedValue(['ProjAlpha'])
    const resp = {
      groups: [
        makeGroup('SOURCE', 'Source Page', [
          { id: 'B_BOTH', content: 'See Project Alpha aka ProjAlpha for the rationale' },
        ]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE_ALPHA', pageTitle: 'Project Alpha' })

    await user.click(await screen.findByRole('button', { name: /unlinked references/i }))
    await waitFor(() => {
      expect(mockedGetPageAliases).toHaveBeenCalledWith('PAGE_ALPHA')
    })

    await user.click(
      await screen.findByRole('button', {
        name: /Link it: replace mention in block B_BOTH/i,
      }),
    )

    await waitFor(() => {
      expect(mockedEditBlock).toHaveBeenCalledWith(
        'B_BOTH',
        'See [[PAGE_ALPHA]] aka ProjAlpha for the rationale',
      )
    })
  })

  it('"Link it" surfaces a toast and skips edit when no candidate matches (PEND-36)', async () => {
    // Reachable when the backend FTS5 match succeeds on a token the
    // regex literal-matcher can't see (e.g. trigram-tokenized CJK
    // alias). The FE must NOT call `editBlock` (would write a
    // duplicate-content edit op) and must NOT optimistically remove
    // the block (would tell the user "linked" while the block reappears
    // on the next refetch).
    const user = userEvent.setup()
    mockedGetPageAliases.mockResolvedValue([])
    const resp = {
      groups: [
        makeGroup('SOURCE', 'Source Page', [
          { id: 'B_GHOST', content: 'No literal match for the title here' },
        ]),
      ],
      next_cursor: null,
      has_more: false,
      total_count: 1,
      filtered_count: 1,
      truncated: false,
    }
    mockedListUnlinked.mockResolvedValue(resp)

    renderUnlinkedReferences({ pageId: 'PAGE_ALPHA', pageTitle: 'Project Alpha' })

    await user.click(await screen.findByRole('button', { name: /unlinked references/i }))
    await waitFor(() => {
      expect(mockedGetPageAliases).toHaveBeenCalledWith('PAGE_ALPHA')
    })

    const linkBtn = await screen.findByRole('button', {
      name: /Link it: replace mention in block B_GHOST/i,
    })
    await user.click(linkBtn)

    // editBlock must not have fired.
    expect(mockedEditBlock).not.toHaveBeenCalled()
    // The block must still be in the DOM (no optimistic removal).
    expect(linkBtn).toBeInTheDocument()
    // logger.warn carries the diagnosis — pin the call so a future
    // refactor doesn't regress to a silent failure.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'UnlinkedReferences',
      'No title/alias match found for Link it',
      expect.objectContaining({ blockId: 'B_GHOST', pageId: 'PAGE_ALPHA' }),
    )
  })

  it('"Link it" reloads aliases when pageId changes (PEND-36)', async () => {
    // Two consecutive renders with different pageIds — the alias fetch
    // must fire for each, otherwise switching pages would carry the
    // previous page's aliases into the new context.
    mockedGetPageAliases.mockResolvedValue([])
    mockedListUnlinked.mockResolvedValue(emptyResponse)

    const { rerender } = renderUnlinkedReferences({
      pageId: 'PAGE_ALPHA',
      pageTitle: 'Project Alpha',
    })
    await waitFor(() => {
      expect(mockedGetPageAliases).toHaveBeenCalledWith('PAGE_ALPHA')
    })

    rerender(
      <TooltipProvider>
        <UnlinkedReferences pageId="PAGE_BETA" pageTitle="Project Beta" />
      </TooltipProvider>,
    )

    await waitFor(() => {
      expect(mockedGetPageAliases).toHaveBeenCalledWith('PAGE_BETA')
    })
    expect(mockedGetPageAliases).toHaveBeenCalledTimes(2)
  })
})
