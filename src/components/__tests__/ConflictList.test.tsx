/**
 * Tests for ConflictList component.
 *
 * Validates:
 *  - Calls get_conflicts on mount
 *  - Renders empty state when no conflicts
 *  - Renders conflict items with type badge and content
 *  - Keep action requires confirmation then calls editBlock + deleteBlock
 *  - Discard requires two-click confirmation (like TrashView purge)
 *  - Cursor-based pagination (Load more)
 *  - Original block content fetched and displayed
 *  - Fallback text when original fetch fails
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ConflictList } from '../ConflictList'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

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

const originalBlock = {
  id: 'ORIG001',
  block_type: 'content',
  content: 'original content',
  parent_id: null,
  position: null,
  deleted_at: null,
  archived_at: null,
  is_conflict: false,
}

const emptyPage = { items: [], next_cursor: null, has_more: false }

/**
 * Helper: set up invoke mock that dispatches by command name.
 * Accepts a map of command → return value (or array of values for sequential calls).
 * Falls back to undefined for unknown commands.
 */
function mockInvokeByCommand(commands: Record<string, unknown | unknown[]>) {
  const callCounts: Record<string, number> = {}
  mockedInvoke.mockImplementation(async (cmd: string) => {
    callCounts[cmd] = (callCounts[cmd] ?? 0) + 1
    const val = commands[cmd]
    if (Array.isArray(val)) {
      const idx = callCounts[cmd] - 1
      if (idx < val.length) return val[idx]
      return undefined
    }
    return val
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ConflictList', () => {
  it('calls get_conflicts on mount', async () => {
    mockInvokeByCommand({ get_conflicts: emptyPage })

    render(<ConflictList />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('get_conflicts', {
        cursor: null,
        limit: 50,
      })
    })
  })

  it('renders empty state when no conflicts', async () => {
    mockInvokeByCommand({ get_conflicts: emptyPage })

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
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    expect(await screen.findByText('conflict content 1')).toBeInTheDocument()
    expect(screen.getByText('conflict content 2')).toBeInTheDocument()

    // Type badges
    const badges = screen.getAllByText('content')
    expect(badges.length).toBeGreaterThanOrEqual(2)
  })

  it('Keep action requires confirmation then calls editBlock + deleteBlock', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({
      get_conflicts: page,
      get_block: originalBlock,
      edit_block: { id: 'ORIG001', block_type: 'content', content: 'conflict text' },
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    // Click Keep — opens confirmation dialog
    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Confirmation dialog is shown
    expect(screen.getByText('Keep incoming version?')).toBeInTheDocument()

    // Confirm
    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

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
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    // First click: shows confirmation
    const discardBtn = await screen.findByRole('button', { name: /Discard/i })
    await user.click(discardBtn)

    expect(screen.getByText('Discard conflict?')).toBeInTheDocument()

    // Only get_conflicts + get_block have been called (no delete yet)
    expect(mockedInvoke).toHaveBeenCalledTimes(2)

    // Clicking "No" cancels
    const noBtn = screen.getByRole('button', { name: /No/i })
    await user.click(noBtn)

    expect(screen.queryByText('Discard conflict?')).not.toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledTimes(2)
  })

  it('pressing Escape dismisses the discard confirmation', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'to discard')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    // First click: shows confirmation
    const discardBtn = await screen.findByRole('button', { name: /Discard/i })
    await user.click(discardBtn)

    expect(screen.getByText('Discard conflict?')).toBeInTheDocument()

    // Press Escape to dismiss
    await user.keyboard('{Escape}')

    expect(screen.queryByText('Discard conflict?')).not.toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledTimes(2) // get_conflicts + get_block only
  })

  it('Discard executes on confirmation Yes click', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'to discard')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    // First click shows confirmation
    const discardBtn = await screen.findByRole('button', { name: /Discard/i })
    await user.click(discardBtn)

    // Second click (Yes) executes discard
    const yesBtn = screen.getByRole('button', { name: /Yes, discard/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'C1' })
    })
  })

  it('removes conflict from list after successful discard', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'will be discarded')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    expect(await screen.findByText('will be discarded')).toBeInTheDocument()

    // Discard with confirmation
    const discardBtn = screen.getByRole('button', { name: /Discard/i })
    await user.click(discardBtn)
    const yesBtn = screen.getByRole('button', { name: /Yes, discard/i })
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
    mockInvokeByCommand({ get_conflicts: page1, get_block: originalBlock })

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
    mockInvokeByCommand({
      get_conflicts: [page1, page2],
      get_block: originalBlock,
    })

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
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
      edit_block: { id: 'ORIG001', block_type: 'content', content: 'will be kept' },
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    expect(await screen.findByText('will be kept')).toBeInTheDocument()

    const keepBtn = screen.getByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Confirm
    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

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
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations when empty', async () => {
    mockInvokeByCommand({ get_conflicts: emptyPage })

    render(<ConflictList />)

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  it('handles error from getConflicts without crashing', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('network failure'))

    render(<ConflictList />)

    // Should render empty state (error caught), not crash
    await waitFor(() => {
      expect(
        screen.getByText(
          /No conflicts\. Conflicts appear when the same block is edited on multiple devices\./,
        ),
      ).toBeInTheDocument()
    })

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load conflicts')
    })
  })

  it('shows toast on failed Keep action', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    // edit_block will reject
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return { items: [conflict], next_cursor: null, has_more: false }
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'edit_block') throw new Error('fail')
      return undefined
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Confirm
    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to resolve conflict')
    })
  })

  it('shows toast on failed Discard action', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text')
    // delete_block will reject
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return { items: [conflict], next_cursor: null, has_more: false }
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'delete_block') throw new Error('fail')
      return undefined
    })

    render(<ConflictList />)

    const discardBtn = await screen.findByRole('button', { name: /Discard/i })
    await user.click(discardBtn)

    const yesBtn = screen.getByRole('button', { name: /Yes, discard/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to resolve conflict')
    })
  })

  it('shows success toast after successful Keep', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
      edit_block: { id: 'ORIG001', block_type: 'content', content: 'conflict text' },
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Confirm
    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Kept selected version')
    })
  })

  it('shows success toast after successful Discard', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    const discardBtn = await screen.findByRole('button', { name: /Discard/i })
    await user.click(discardBtn)

    const yesBtn = screen.getByRole('button', { name: /Yes, discard/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Conflict discarded')
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
    mockInvokeByCommand({
      get_conflicts: page,
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Confirm
    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

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
    mockInvokeByCommand({
      get_conflicts: page,
      get_block: originalBlock,
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Confirm
    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'C1' })
    })

    // editBlock should NOT have been called (content is null)
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
  })

  // --- New tests for original block display and Keep confirmation ---

  it('fetches and displays original block content for comparison', async () => {
    const conflict = makeConflict('C1', 'new version', 'ORIG001')
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({
      get_conflicts: page,
      get_block: {
        id: 'ORIG001',
        block_type: 'content',
        content: 'old version',
        parent_id: null,
        position: null,
        deleted_at: null,
        archived_at: null,
        is_conflict: false,
      },
    })

    render(<ConflictList />)

    // "Current:" label + original content
    expect(await screen.findByText('Current:')).toBeInTheDocument()
    expect(screen.getByText('old version')).toBeInTheDocument()

    // "Incoming:" label + conflict content
    expect(screen.getByText('Incoming:')).toBeInTheDocument()
    expect(screen.getByText('new version')).toBeInTheDocument()

    // Verify get_block was called with the parent_id
    expect(mockedInvoke).toHaveBeenCalledWith('get_block', { blockId: 'ORIG001' })
  })

  it('shows fallback text when original block fetch fails', async () => {
    const conflict = makeConflict('C1', 'conflict text', 'ORIG_GONE')
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    // get_block rejects to simulate deleted/unavailable original
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return page
      if (cmd === 'get_block') throw new Error('not found')
      return undefined
    })

    render(<ConflictList />)

    // Should show fallback text for the original
    expect(await screen.findByText('(original not available)')).toBeInTheDocument()

    // Incoming content is still shown
    expect(screen.getByText('conflict text')).toBeInTheDocument()
  })

  it('Keep confirmation dialog opens on Keep click', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Dialog should be visible
    expect(screen.getByText('Keep incoming version?')).toBeInTheDocument()
    expect(
      screen.getByText('This will replace the current content with the incoming version.'),
    ).toBeInTheDocument()

    // edit_block/delete_block should NOT have been called yet
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())
  })

  it('Keep confirmation dialog completes the operation on confirm', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'incoming text', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
      edit_block: { id: 'ORIG001', block_type: 'content', content: 'incoming text' },
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    // Open Keep confirmation
    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)
    expect(screen.getByText('Keep incoming version?')).toBeInTheDocument()

    // Confirm
    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    // edit_block should be called with parent_id and conflict content
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'ORIG001',
        toText: 'incoming text',
      })
    })

    // delete_block should be called to remove the conflict
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'C1' })
    })

    // Conflict should be removed from the list
    await waitFor(() => {
      expect(screen.queryByText('incoming text')).not.toBeInTheDocument()
    })

    // Success toast
    expect(toast.success).toHaveBeenCalledWith('Kept selected version')
  })

  it('Keep confirmation dialog can be cancelled', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    // Open Keep confirmation
    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)
    expect(screen.getByText('Keep incoming version?')).toBeInTheDocument()

    // Cancel
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
    await user.click(cancelBtn)

    // Dialog should be dismissed
    expect(screen.queryByText('Keep incoming version?')).not.toBeInTheDocument()

    // No edit/delete calls
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())

    // Conflict is still in the list
    expect(screen.getByText('conflict text')).toBeInTheDocument()
  })

  // --- Tests for conflict type badges and metadata (#224) ---

  it('renders conflict type badge with "Text" for each conflict', async () => {
    const page = {
      items: [makeConflict('C1', 'conflict content 1'), makeConflict('C2', 'conflict content 2')],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict content 1')

    // Each conflict item should have a "Text" conflict type badge
    const typeBadges = container.querySelectorAll('.conflict-type-badge')
    expect(typeBadges).toHaveLength(2)
    expect(typeBadges[0].textContent).toBe('Text')
    expect(typeBadges[1].textContent).toBe('Text')
  })

  it('displays conflict metadata: source block ID (truncated)', async () => {
    const conflict = makeConflict('CONFLICT-ID-VERY-LONG-1234', 'conflict text')
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict text')

    // Source ID should be truncated and shown
    const sourceId = container.querySelector('.conflict-source-id')
    expect(sourceId).toBeTruthy()
    expect(sourceId?.textContent).toContain('ID:')
    expect(sourceId?.textContent).toContain('CONFLICT-ID-...')
  })

  it('displays conflict metadata: timestamp', async () => {
    const conflict = {
      id: 'C1',
      block_type: 'content',
      content: 'conflict text',
      parent_id: 'ORIG001',
      position: null,
      deleted_at: '2025-06-15T10:30:00Z',
      archived_at: null,
      is_conflict: true,
    }
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict text')

    // Timestamp should be displayed in the metadata area
    const timestamp = container.querySelector('.conflict-timestamp')
    expect(timestamp).toBeTruthy()
    // The timestamp should contain some formatted date text (not "Unknown")
    expect(timestamp?.textContent).not.toBe('')
    expect(timestamp?.textContent).not.toBe('Unknown')
  })

  it('shows "Unknown" timestamp when deleted_at and archived_at are null', async () => {
    const conflict = makeConflict('C1', 'conflict text')
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict text')

    const timestamp = container.querySelector('.conflict-timestamp')
    expect(timestamp).toBeTruthy()
    expect(timestamp?.textContent).toBe('Unknown')
  })

  it('conflict type badge has amber styling for Text type', async () => {
    const page = {
      items: [makeConflict('C1', 'conflict content')],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict content')

    const typeBadge = container.querySelector('.conflict-type-badge')
    expect(typeBadge).toBeTruthy()
    expect(typeBadge?.className).toContain('bg-amber-100')
    expect(typeBadge?.className).toContain('text-amber-800')
  })

  it('Keep/Discard flow still works with badges and metadata present', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict with badge', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
      edit_block: { id: 'ORIG001', block_type: 'content', content: 'conflict with badge' },
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    await screen.findByText('conflict with badge')

    // Verify badge is present
    expect(screen.getByText('Text')).toBeInTheDocument()

    // Keep still works
    const keepBtn = screen.getByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'ORIG001',
        toText: 'conflict with badge',
      })
    })

    await waitFor(() => {
      expect(screen.queryByText('conflict with badge')).not.toBeInTheDocument()
    })
  })
})
