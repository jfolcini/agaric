/**
 * Tests for PageBrowser component.
 *
 * Validates:
 *  - Initial load calls listBlocks with blockType='page'
 *  - Cursor-based pagination (Load More button)
 *  - Empty state and loading states
 *  - Page selection callback
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PageBrowser } from '../PageBrowser'

const mockedInvoke = vi.mocked(invoke)

function makePage(id: string, content: string) {
  return {
    id,
    block_type: 'page',
    content,
    parent_id: null,
    position: null,
    deleted_at: null,
    archived_at: null,
    is_conflict: false,
  }
}

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PageBrowser', () => {
  it('calls listBlocks with blockType=page on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<PageBrowser />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
        parentId: null,
        blockType: 'page',
        tagId: null,
        showDeleted: null,
        agendaDate: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  it('renders pages when data is returned', async () => {
    const page = {
      items: [makePage('P1', 'First page'), makePage('P2', 'Second page')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<PageBrowser />)

    expect(await screen.findByText('First page')).toBeInTheDocument()
    expect(screen.getByText('Second page')).toBeInTheDocument()
  })

  it('renders empty state when no pages exist', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<PageBrowser />)

    expect(await screen.findByText(/No pages yet/)).toBeInTheDocument()
  })

  it('shows Untitled for pages with null content', async () => {
    const page = {
      items: [
        {
          ...makePage('P1', ''),
          content: null,
        },
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<PageBrowser />)

    expect(await screen.findByText('Untitled')).toBeInTheDocument()
  })

  it('uses cursor-based pagination with Load More', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makePage('P1', 'Page 1')],
      next_cursor: 'cursor_abc',
      has_more: true,
    }
    const page2 = {
      items: [makePage('P2', 'Page 2')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    render(<PageBrowser />)

    // Load More button should be visible after initial load
    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()

    await user.click(loadMoreBtn)

    // Should call with the cursor from page 1
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
        parentId: null,
        blockType: 'page',
        tagId: null,
        showDeleted: null,
        agendaDate: null,
        cursor: 'cursor_abc',
        limit: 50,
      })
    })

    // Both pages should be rendered (accumulated)
    expect(await screen.findByText('Page 1')).toBeInTheDocument()
    expect(screen.getByText('Page 2')).toBeInTheDocument()

    // Load More should disappear after last page
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument()
  })

  it('fires onPageSelect callback when a page is clicked', async () => {
    const user = userEvent.setup()
    const onPageSelect = vi.fn()
    const page = {
      items: [makePage('P1', 'Click me')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<PageBrowser onPageSelect={onPageSelect} />)

    const item = await screen.findByRole('button', { name: /Click me/i })
    await user.click(item)

    expect(onPageSelect).toHaveBeenCalledWith('P1', 'Click me')
  })

  it('has no a11y violations', async () => {
    const page = {
      items: [makePage('P1', 'Accessible page')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    const { container } = render(<PageBrowser />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
