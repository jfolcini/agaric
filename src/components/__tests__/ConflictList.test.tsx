/**
 * Tests for ConflictList component.
 *
 * Validates:
 *  - Calls get_conflicts on mount
 *  - Renders empty state when no conflicts
 *  - Renders conflict items with type badge and content
 *  - Keep action calls editBlock then deleteBlock
 *  - Discard requires two-click confirmation (like TrashView purge)
 *  - Cursor-based pagination (Load more)
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ConflictList } from '../ConflictList'

const mockedInvoke = vi.mocked(invoke)

function makeConflict(id: string, content: string, parentId: string | null = 'ORIG001') {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: parentId,
    position: null,
    deleted_at: null,
    archived_at: null,
    is_conflict: true,
  }
}

const emptyPage = { items: [], next_cursor: null, has_more: false }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ConflictList', () => {
  it('calls get_conflicts on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<ConflictList />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_conflicts', {
        cursor: null,
        limit: 50,
      })
    })
  })

  it('renders empty state when no conflicts', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<ConflictList />)

    expect(
      await screen.findByText(
        /No conflicts\. Conflicts appear when the same block is edited on multiple devices\./,
      ),
    ).toBeInTheDocument()
  })

  it('renders conflict items with type badge and content', async () => {
    const page = {
      items: [makeConflict('C1', 'conflict content 1'), makeConflict('C2', 'conflict content 2')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<ConflictList />)

    expect(await screen.findByText('conflict content 1')).toBeInTheDocument()
    expect(screen.getByText('conflict content 2')).toBeInTheDocument()

    // Type badges
    const badges = screen.getAllByText('content')
    expect(badges.length).toBeGreaterThanOrEqual(2)
  })

  it('Keep action calls editBlock on parent then deleteBlock on conflict', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // get_conflicts
      .mockResolvedValueOnce({ id: 'ORIG001', block_type: 'content', content: 'conflict text' }) // edit_block
      .mockResolvedValueOnce({
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      }) // delete_block

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'ORIG001',
        toText: 'conflict text',
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', {
        blockId: 'C1',
      })
    })
  })

  it('Discard requires two-click confirmation', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'to discard')
    mockedInvoke.mockResolvedValueOnce({
      items: [conflict],
      next_cursor: null,
      has_more: false,
    })

    render(<ConflictList />)

    // First click: shows confirmation
    const discardBtn = await screen.findByRole('button', { name: /Discard/i })
    await user.click(discardBtn)

    expect(screen.getByText('Discard conflict?')).toBeInTheDocument()

    // Only get_conflicts has been called
    expect(mockedInvoke).toHaveBeenCalledTimes(1)

    // Clicking "No" cancels
    const noBtn = screen.getByRole('button', { name: /No/i })
    await user.click(noBtn)

    expect(screen.queryByText('Discard conflict?')).not.toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })

  it('pressing Escape dismisses the discard confirmation', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'to discard')
    mockedInvoke.mockResolvedValueOnce({
      items: [conflict],
      next_cursor: null,
      has_more: false,
    })

    render(<ConflictList />)

    // First click: shows confirmation
    const discardBtn = await screen.findByRole('button', { name: /Discard/i })
    await user.click(discardBtn)

    expect(screen.getByText('Discard conflict?')).toBeInTheDocument()

    // Press Escape to dismiss
    await user.keyboard('{Escape}')

    expect(screen.queryByText('Discard conflict?')).not.toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledTimes(1) // Only the initial get_conflicts call
  })

  it('Discard executes on confirmation Yes click', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'to discard')
    mockedInvoke
      .mockResolvedValueOnce({ items: [conflict], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      })

    render(<ConflictList />)

    // First click shows confirmation
    const discardBtn = await screen.findByRole('button', { name: /Discard/i })
    await user.click(discardBtn)

    // Second click (Yes) executes discard
    const yesBtn = screen.getByRole('button', { name: /Yes/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'C1' })
    })
  })

  it('removes conflict from list after successful discard', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'will be discarded')
    mockedInvoke
      .mockResolvedValueOnce({ items: [conflict], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      })

    render(<ConflictList />)

    expect(await screen.findByText('will be discarded')).toBeInTheDocument()

    // Discard with confirmation
    const discardBtn = screen.getByRole('button', { name: /Discard/i })
    await user.click(discardBtn)
    const yesBtn = screen.getByRole('button', { name: /Yes/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(screen.queryByText('will be discarded')).not.toBeInTheDocument()
    })
  })

  it('shows Load More button when has_more is true', async () => {
    const page1 = {
      items: [makeConflict('C1', 'conflict 1')],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(page1)

    render(<ConflictList />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()
  })

  it('loads next page with cursor when Load More is clicked', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makeConflict('C1', 'conflict 1')],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    const page2 = {
      items: [makeConflict('C2', 'conflict 2')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    render(<ConflictList />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    await user.click(loadMoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_conflicts', {
        cursor: 'cursor_page2',
        limit: 50,
      })
    })

    expect(await screen.findByText('conflict 1')).toBeInTheDocument()
    expect(screen.getByText('conflict 2')).toBeInTheDocument()
  })

  it('removes conflict from list after successful Keep', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'will be kept', 'ORIG001')
    mockedInvoke
      .mockResolvedValueOnce({ items: [conflict], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({ id: 'ORIG001', block_type: 'content', content: 'will be kept' })
      .mockResolvedValueOnce({
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      })

    render(<ConflictList />)

    expect(await screen.findByText('will be kept')).toBeInTheDocument()

    const keepBtn = screen.getByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    await waitFor(() => {
      expect(screen.queryByText('will be kept')).not.toBeInTheDocument()
    })
  })

  it('has no a11y violations with items', async () => {
    const page = {
      items: [makeConflict('C1', 'accessible conflict')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<ConflictList />)

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations when empty', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<ConflictList />)

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  it('handles error from getConflicts without crashing', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('network failure'))

    render(<ConflictList />)

    // Should render empty state (error silently caught), not crash
    await waitFor(() => {
      expect(
        screen.getByText(
          /No conflicts\. Conflicts appear when the same block is edited on multiple devices\./,
        ),
      ).toBeInTheDocument()
    })
  })

  it('Keep with null parent_id only deletes the conflict (skips editBlock)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'orphan conflict', null)
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // get_conflicts
      .mockResolvedValueOnce({
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      }) // delete_block

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'C1' })
    })

    // editBlock should NOT have been called (parent_id is null)
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
  })

  it('Keep with null content only deletes the conflict (skips editBlock)', async () => {
    const user = userEvent.setup()
    const conflict = {
      id: 'C1',
      block_type: 'content',
      content: null,
      parent_id: 'ORIG001',
      position: null,
      deleted_at: null,
      archived_at: null,
      is_conflict: true,
    }
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke
      .mockResolvedValueOnce(page) // get_conflicts
      .mockResolvedValueOnce({
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      }) // delete_block

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'C1' })
    })

    // editBlock should NOT have been called (content is null)
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
  })
})
