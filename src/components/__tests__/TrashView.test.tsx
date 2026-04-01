/**
 * Tests for TrashView component.
 *
 * Validates:
 *  - Initial load calls listBlocks({ showDeleted: true })
 *  - Renders block items with restore/purge controls
 *  - Restore passes deleted_at_ref to restoreBlock
 *  - Purge requires explicit confirmation (two-click)
 *  - Cursor-based pagination (load more)
 *  - Empty state rendering
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { TrashView } from '../TrashView'

const mockedInvoke = vi.mocked(invoke)

function makeBlock(id: string, content: string, deletedAt: string) {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: null,
    position: null,
    deleted_at: deletedAt,
    archived_at: null,
    is_conflict: false,
  }
}

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TrashView', () => {
  it('calls listBlocks with showDeleted:true on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<TrashView />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
        parentId: null,
        blockType: null,
        tagId: null,
        showDeleted: true,
        agendaDate: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  it('renders empty state when no deleted blocks', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<TrashView />)

    expect(
      await screen.findByText(/Nothing in trash\. Deleted items will appear here\./),
    ).toBeInTheDocument()
  })

  it('renders deleted blocks with restore and purge buttons', async () => {
    const page = {
      items: [
        makeBlock('B1', 'deleted item 1', '2025-01-15T00:00:00Z'),
        makeBlock('B2', 'deleted item 2', '2025-01-14T00:00:00Z'),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<TrashView />)

    // Wait for items to render
    expect(await screen.findByText('deleted item 1')).toBeInTheDocument()
    expect(screen.getByText('deleted item 2')).toBeInTheDocument()

    // Each item should have a restore button
    const restoreBtns = screen.getAllByRole('button', { name: /Restore/i })
    expect(restoreBtns).toHaveLength(2)

    // Each item should have a purge button
    const purgeBtns = screen.getAllByRole('button', { name: /Purge/i })
    expect(purgeBtns).toHaveLength(2)
  })

  it('restore calls restoreBlock with correct deleted_at_ref', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'item', '2025-01-15T12:00:00Z')
    mockedInvoke
      .mockResolvedValueOnce({ items: [block], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({ block_id: 'B1', restored_count: 1 })

    render(<TrashView />)

    const restoreBtn = await screen.findByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // The second invoke call should be restore_block with the deleted_at_ref
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restore_block', {
        blockId: 'B1',
        deletedAtRef: '2025-01-15T12:00:00Z',
      })
    })
  })

  it('purge requires two-click confirmation', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'to purge', '2025-01-15T00:00:00Z')
    mockedInvoke.mockResolvedValueOnce({
      items: [block],
      next_cursor: null,
      has_more: false,
    })

    render(<TrashView />)

    // First click: should show confirmation, NOT call purge_block
    const purgeBtn = await screen.findByRole('button', { name: /Purge/i })
    await user.click(purgeBtn)

    // After first click, confirmation dialog should appear
    expect(screen.getByText('Permanently delete?')).toBeInTheDocument()

    // invoke should NOT have been called for purge yet (only the initial list_blocks)
    expect(mockedInvoke).toHaveBeenCalledTimes(1)

    // Clicking "No" should cancel
    const noBtn = screen.getByRole('button', { name: /No/i })
    await user.click(noBtn)

    expect(screen.queryByText('Permanently delete?')).not.toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledTimes(1) // Still only the initial list call
  })

  it('pressing Escape dismisses the purge confirmation', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'to purge', '2025-01-15T00:00:00Z')
    mockedInvoke.mockResolvedValueOnce({
      items: [block],
      next_cursor: null,
      has_more: false,
    })

    render(<TrashView />)

    // First click: shows confirmation
    const purgeBtn = await screen.findByRole('button', { name: /Purge/i })
    await user.click(purgeBtn)

    expect(screen.getByText('Permanently delete?')).toBeInTheDocument()

    // Press Escape to dismiss
    await user.keyboard('{Escape}')

    expect(screen.queryByText('Permanently delete?')).not.toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledTimes(1) // Only the initial list call
  })

  it('purge executes on confirmation Yes click', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'to purge', '2025-01-15T00:00:00Z')
    mockedInvoke
      .mockResolvedValueOnce({ items: [block], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({ block_id: 'B1', purged_count: 1 })

    render(<TrashView />)

    // First click shows confirmation
    const purgeBtn = await screen.findByRole('button', { name: /Purge/i })
    await user.click(purgeBtn)

    // Second click (Yes) executes purge
    const yesBtn = screen.getByRole('button', { name: /Yes/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('purge_block', { blockId: 'B1' })
    })
  })

  it('shows Load More button when has_more is true', async () => {
    const page1 = {
      items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(page1)

    render(<TrashView />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()
  })

  it('loads next page with cursor when Load More is clicked', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    const page2 = {
      items: [makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    render(<TrashView />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    // Second call should use the cursor from page 1
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
        parentId: null,
        blockType: null,
        tagId: null,
        showDeleted: true,
        agendaDate: null,
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    // Both items should now be rendered
    expect(await screen.findByText('item 1')).toBeInTheDocument()
    expect(screen.getByText('item 2')).toBeInTheDocument()
  })

  it('hides Load More button when no more pages', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<TrashView />)

    await screen.findByText(/Nothing in trash\. Deleted items will appear here\./)
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument()
  })

  it('removes block from list after successful restore', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'to restore', '2025-01-15T00:00:00Z')
    mockedInvoke
      .mockResolvedValueOnce({ items: [block], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({ block_id: 'B1', restored_count: 1 })

    render(<TrashView />)

    expect(await screen.findByText('to restore')).toBeInTheDocument()

    const restoreBtn = screen.getByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // Block should be removed from the list
    await waitFor(() => {
      expect(screen.queryByText('to restore')).not.toBeInTheDocument()
    })
  })

  // ── Error handling ──────────────────────────────────────────────────

  it('handles failed load gracefully', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('DB error'))

    render(<TrashView />)

    // Component silently catches the error, loading ends, blocks stays empty
    // so the empty state is shown
    expect(
      await screen.findByText(/Nothing in trash\. Deleted items will appear here\./),
    ).toBeInTheDocument()
  })

  it('handles failed restore gracefully', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'item', '2025-01-15T00:00:00Z')
    mockedInvoke
      .mockResolvedValueOnce({ items: [block], next_cursor: null, has_more: false })
      .mockRejectedValueOnce(new Error('Restore failed'))

    render(<TrashView />)

    const restoreBtn = await screen.findByRole('button', { name: /Restore/i })
    await user.click(restoreBtn)

    // Block should still be in the list (restore failed silently, so don't remove it)
    await waitFor(() => {
      expect(screen.getByText('item')).toBeInTheDocument()
    })
  })

  it('handles failed purge gracefully', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'item', '2025-01-15T00:00:00Z')
    mockedInvoke
      .mockResolvedValueOnce({ items: [block], next_cursor: null, has_more: false })
      .mockRejectedValueOnce(new Error('Purge failed'))

    render(<TrashView />)

    // First click shows confirmation
    const purgeBtn = await screen.findByRole('button', { name: /Purge/i })
    await user.click(purgeBtn)

    // Second click (Yes) triggers purge which fails
    const yesBtn = screen.getByRole('button', { name: /Yes/i })
    await user.click(yesBtn)

    // Block should still be in the list (purge failed silently)
    await waitFor(() => {
      expect(screen.getByText('item')).toBeInTheDocument()
    })
  })

  // ── a11y ────────────────────────────────────────────────────────────

  it('has no a11y violations', async () => {
    const page = {
      items: [makeBlock('B1', 'accessible item', '2025-01-15T00:00:00Z')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<TrashView />)

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })
})
