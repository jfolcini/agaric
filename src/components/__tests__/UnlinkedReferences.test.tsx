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

vi.mock('../../lib/tauri', () => ({
  listUnlinkedReferences: vi.fn(),
  editBlock: vi.fn(),
}))

vi.mock('lucide-react', () => ({
  ChevronRight: (props: Record<string, unknown>) => <svg data-testid="chevron-right" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <svg data-testid="chevron-down" {...props} />,
  Link2: (props: Record<string, unknown>) => <svg data-testid="link2-icon" {...props} />,
  Loader2: (props: Record<string, unknown>) => <svg data-testid="loader2-icon" {...props} />,
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

import { editBlock, listUnlinkedReferences } from '../../lib/tauri'
import { UnlinkedReferences } from '../UnlinkedReferences'

const mockedListUnlinked = vi.mocked(listUnlinkedReferences)
const mockedEditBlock = vi.mocked(editBlock)

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
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    })),
  }
}

const emptyResponse = {
  groups: [],
  next_cursor: null,
  has_more: false,
  total_count: 0,
  filtered_count: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedListUnlinked.mockResolvedValue(emptyResponse)
  mockedEditBlock.mockResolvedValue({
    id: 'BLOCK',
    block_type: 'content',
    content: '',
    parent_id: 'P1',
    position: 0,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
    conflict_type: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
  })
})

describe('UnlinkedReferences', () => {
  // 1. Renders collapsed by default
  it('renders collapsed by default — header visible, content not visible', () => {
    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

    // Header should be present
    const header = screen.getByRole('button', { name: /unlinked references/i })
    expect(header).toBeInTheDocument()
    expect(header).toHaveAttribute('aria-expanded', 'false')

    // Content should NOT be visible (collapsed)
    expect(document.querySelector('.unlinked-references-content')).not.toBeInTheDocument()

    // listUnlinkedReferences should NOT have been called (lazy load)
    expect(mockedListUnlinked).not.toHaveBeenCalled()
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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    await screen.findByText('first My Page ref')
    expect(screen.getByText('second My Page ref')).toBeInTheDocument()

    // Click the first "Link it" button
    const linkItBtns = screen.getAllByRole('button', { name: /link it/i })
    await user.click(linkItBtns[0])

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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    const page2 = {
      groups: [makeGroup('P2', 'Page Two', [{ id: 'B2', content: 'block 2' }])],
      next_cursor: null,
      has_more: false,
      total_count: 2,
      filtered_count: 2,
    }
    let callCount = 0
    mockedListUnlinked.mockImplementation(async () => {
      callCount++
      return callCount === 1 ? page1 : page2
    })

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp1)

    const { rerender } = render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp2)

    // Re-render with new pageId — component should collapse back
    rerender(<UnlinkedReferences pageId="PAGE2" pageTitle="Other Page" />)

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

  // 11. Shows "No Unlinked References" when totalCount is 0
  it('shows "No Unlinked References" when totalCount is 0', async () => {
    const user = userEvent.setup()
    mockedListUnlinked.mockResolvedValue(emptyResponse)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

    // Expand
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))

    // Should show "No Unlinked References" in header
    await waitFor(() => {
      expect(screen.getByText('No Unlinked References')).toBeInTheDocument()
    })

    // Empty state message
    expect(screen.getByText('No unlinked references found.')).toBeInTheDocument()
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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    const { container } = render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp)

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)

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
    }
    mockedListUnlinked.mockResolvedValue(resp)
    mockedEditBlock.mockRejectedValueOnce(new Error('backend error'))

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)
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
    }
    mockedListUnlinked.mockResolvedValue(resp)
    mockedEditBlock.mockResolvedValueOnce({
      id: 'B1',
      block_type: 'block',
      content: 'I love [[PAGE1]] coding',
      parent_id: 'P1',
      position: 0,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    })

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="C++" />)
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
    }
    mockedListUnlinked.mockResolvedValue(resp)
    mockedEditBlock.mockResolvedValueOnce({
      id: 'B1',
      block_type: 'block',
      content: '[[PAGE1]] mentions My Page twice',
      parent_id: 'P1',
      position: 0,
      deleted_at: null,
      archived_at: null,
      is_conflict: false,
      conflict_type: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    })

    render(<UnlinkedReferences pageId="PAGE1" pageTitle="My Page" />)
    await user.click(screen.getByRole('button', { name: /unlinked references/i }))
    await screen.findByText('My Page mentions My Page twice')

    await user.click(screen.getByRole('button', { name: /link it/i }))

    // Only first occurrence replaced
    expect(mockedEditBlock).toHaveBeenCalledWith('B1', '[[PAGE1]] mentions My Page twice')
  })
})
