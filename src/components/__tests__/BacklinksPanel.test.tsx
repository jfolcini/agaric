/**
 * Tests for BacklinksPanel component.
 *
 * Validates:
 *  - Renders "Select a block" when blockId is null
 *  - Renders empty state when no backlinks found
 *  - Renders backlink items with type badge, content preview, truncated ID
 *  - Cursor-based pagination (Load more)
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { BacklinksPanel } from '../BacklinksPanel'

const mockedInvoke = vi.mocked(invoke)

function makeBlock(id: string, content: string, blockType = 'content') {
  return {
    id,
    block_type: blockType,
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

describe('BacklinksPanel', () => {
  it('renders null blockId state', () => {
    render(<BacklinksPanel blockId={null} />)

    expect(screen.getByText('Select a block to see backlinks')).toBeInTheDocument()
  })

  it('renders empty state when no backlinks found', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<BacklinksPanel blockId="BLOCK001" />)

    expect(await screen.findByText('No backlinks found')).toBeInTheDocument()
  })

  it('calls get_backlinks with correct params on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<BacklinksPanel blockId="BLOCK001" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
        blockId: 'BLOCK001',
        cursor: null,
        limit: 50,
      })
    })
  })

  it('renders backlink items with type badge and content', async () => {
    const page = {
      items: [
        makeBlock('01HAAAAA00000000000001', 'Links to this block', 'content'),
        makeBlock('01HBBBBB00000000000002', 'Another reference', 'page'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<BacklinksPanel blockId="TARGET01" />)

    expect(await screen.findByText('Links to this block')).toBeInTheDocument()
    expect(screen.getByText('Another reference')).toBeInTheDocument()

    // Type badges
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.getByText('page')).toBeInTheDocument()

    // Truncated IDs (first 8 chars + ...)
    expect(screen.getByText('01HAAAAA...')).toBeInTheDocument()
    expect(screen.getByText('01HBBBBB...')).toBeInTheDocument()
  })

  it('shows Load More button when has_more is true', async () => {
    const page1 = {
      items: [makeBlock('B1', 'item 1')],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(page1)

    render(<BacklinksPanel blockId="TARGET01" />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()
  })

  it('loads next page with cursor when Load More is clicked', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makeBlock('B1', 'item 1')],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    const page2 = {
      items: [makeBlock('B2', 'item 2')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    render(<BacklinksPanel blockId="TARGET01" />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
        blockId: 'TARGET01',
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    // Both items should be rendered
    expect(await screen.findByText('item 1')).toBeInTheDocument()
    expect(screen.getByText('item 2')).toBeInTheDocument()
  })

  it('reloads when blockId changes', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    const { rerender } = render(<BacklinksPanel blockId="BLOCK_A" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
        blockId: 'BLOCK_A',
        cursor: null,
        limit: 50,
      })
    })

    rerender(<BacklinksPanel blockId="BLOCK_B" />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_backlinks', {
        blockId: 'BLOCK_B',
        cursor: null,
        limit: 50,
      })
    })
  })

  it('has no a11y violations with items', async () => {
    const page = {
      items: [makeBlock('B1', 'accessible backlink')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    const { container } = render(<BacklinksPanel blockId="TARGET01" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with null blockId', async () => {
    const { container } = render(<BacklinksPanel blockId={null} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('handles error from getBacklinks without crashing', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('network failure'))

    render(<BacklinksPanel blockId="BLOCK001" />)

    // Should render empty state (error silently caught), not crash
    await waitFor(() => {
      expect(screen.getByText('No backlinks found')).toBeInTheDocument()
    })
  })
})
