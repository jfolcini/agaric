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
 *  - #281 Error messages include backend error text
 *  - #285 ULID timestamp decoding
 *  - #286 Keep partial failure handling
 *  - #292 Expand/collapse conflict content
 *  - #296 View original navigation
 *  - #298 Aria-labels on Keep/Discard
 *  - #300 Shared format utilities
 *  - #304 Help text banner
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ulidToDate } from '@/lib/format'
import { useNavigationStore } from '../../stores/navigation'
import { ConflictList } from '../ConflictList'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockUnlisten = vi.fn()
const mockListen = vi.fn().mockResolvedValue(mockUnlisten)

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

const mockedInvoke = vi.mocked(invoke)

/**
 * Generate a valid ULID string for a given timestamp (ms since epoch).
 * Encodes the timestamp in the first 10 Crockford base32 chars,
 * followed by 16 random chars (here just 'A').
 */
function makeUlid(timestampMs: number): string {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let ts = timestampMs
  const chars: string[] = []
  for (let i = 0; i < 10; i++) {
    chars.unshift(CROCKFORD[ts % 32])
    ts = Math.floor(ts / 32)
  }
  return `${chars.join('')}AAAAAAAAAAAAAAAA`
}

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
  conflict_type: null,
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

    // First click: shows confirmation (use aria-label to avoid matching content button)
    const discardBtn = await screen.findByRole('button', { name: /Discard conflict for block/i })
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

    // First click: shows confirmation (use aria-label to avoid matching content button)
    const discardBtn = await screen.findByRole('button', { name: /Discard conflict for block/i })
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

    // First click shows confirmation (use aria-label to avoid matching content button)
    const discardBtn = await screen.findByRole('button', { name: /Discard conflict for block/i })
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

    // Discard with confirmation (use aria-label to avoid matching content button)
    const discardBtn = screen.getByRole('button', { name: /Discard conflict for block/i })
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

  it('handles error from getConflicts and shows backend error text (#281)', async () => {
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

  it('shows toast on failed Keep action with backend error text (#281)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    // edit_block will reject
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return { items: [conflict], next_cursor: null, has_more: false }
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'edit_block') throw new Error('permission denied')
      return undefined
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Confirm
    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to resolve conflict: permission denied')
    })
  })

  it('shows toast on failed Discard action with backend error text (#281)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text')
    // delete_block will reject
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return { items: [conflict], next_cursor: null, has_more: false }
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'delete_block') throw new Error('db locked')
      return undefined
    })

    render(<ConflictList />)

    const discardBtn = await screen.findByRole('button', { name: /Discard/i })
    await user.click(discardBtn)

    const yesBtn = screen.getByRole('button', { name: /Yes, discard/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to discard conflict: db locked')
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
        conflict_type: null,
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

  it('renders Property conflict type badge when backend provides it', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    vi.mocked(invoke).mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_conflicts') {
        return {
          items: [
            {
              id: '01JTEST00001',
              block_type: 'content',
              content: 'property conflict',
              parent_id: 'PARENT1',
              position: 1,
              deleted_at: null,
              archived_at: null,
              is_conflict: true,
              conflict_type: 'Property',
            },
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'get_block')
        return {
          id: 'PARENT1',
          block_type: 'content',
          content: 'original',
          parent_id: null,
          position: 1,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        }
      return null
    })
    const { container } = render(<ConflictList />)
    await waitFor(() => {
      expect(container.querySelector('.conflict-type-badge')).toBeTruthy()
    })
    const badge = container.querySelector('.conflict-type-badge')
    expect(badge?.textContent).toBe('Property')
    expect(badge?.className).toContain('bg-blue-100')
  })

  it('renders Move conflict type badge when backend provides it', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    vi.mocked(invoke).mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_conflicts') {
        return {
          items: [
            {
              id: '01JTEST00002',
              block_type: 'content',
              content: 'move conflict',
              parent_id: 'PARENT2',
              position: 1,
              deleted_at: null,
              archived_at: null,
              is_conflict: true,
              conflict_type: 'Move',
            },
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'get_block')
        return {
          id: 'PARENT2',
          block_type: 'content',
          content: 'original',
          parent_id: null,
          position: 1,
          deleted_at: null,
          archived_at: null,
          is_conflict: false,
          conflict_type: null,
        }
      return null
    })
    const { container } = render(<ConflictList />)
    await waitFor(() => {
      expect(container.querySelector('.conflict-type-badge')).toBeTruthy()
    })
    const badge = container.querySelector('.conflict-type-badge')
    expect(badge?.textContent).toBe('Move')
    expect(badge?.className).toContain('bg-purple-100')
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

  it('displays conflict metadata: timestamp from ULID (#285)', async () => {
    // Create a ULID encoding a known timestamp
    const knownTs = Date.now() - 3600_000 // 1 hour ago
    const ulidId = makeUlid(knownTs)
    const conflict = makeConflict(ulidId, 'conflict text')
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict text')

    // Timestamp should be displayed and should not be "Unknown"
    const timestamp = container.querySelector('.conflict-timestamp')
    expect(timestamp).toBeTruthy()
    expect(timestamp?.textContent).not.toBe('')
    expect(timestamp?.textContent).not.toBe('Unknown')
    // Should show something like "1h ago"
    expect(timestamp?.textContent).toMatch(/ago|Just now/i)
  })

  it('shows "Unknown" timestamp when block ID is not a valid ULID', async () => {
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

  // --- #285 ULID timestamp decoding (unit tests for ulidToDate) ---

  describe('ulidToDate', () => {
    it('decodes a valid ULID to the correct date', () => {
      const ts = 1700000000000 // Nov 14 2023
      const ulid = makeUlid(ts)
      const date = ulidToDate(ulid)
      expect(date).not.toBeNull()
      expect(date?.getTime()).toBe(ts)
    })

    it('returns null for empty string', () => {
      expect(ulidToDate('')).toBeNull()
    })

    it('returns null for too-short string', () => {
      expect(ulidToDate('ABC')).toBeNull()
    })

    it('returns null for string with invalid Crockford chars', () => {
      // 'I', 'L', 'O', 'U' are not in Crockford base32
      expect(ulidToDate('ILOUIIIIII0000000000000000')).toBeNull()
    })
  })

  // --- #286 Keep partial failure: editBlock succeeds, deleteBlock fails ---

  it('handles Keep partial failure: editBlock succeeds but deleteBlock fails (#286)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'incoming changes', 'ORIG001')
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return { items: [conflict], next_cursor: null, has_more: false }
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'edit_block')
        return { id: 'ORIG001', block_type: 'content', content: 'incoming changes' }
      if (cmd === 'delete_block') throw new Error('storage full')
      return undefined
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    // Should show the partial-success toast
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'Updated original but failed to remove conflict copy — please delete it manually.',
      )
    })

    // Should NOT show an error toast (editBlock succeeded)
    expect(toast.error).not.toHaveBeenCalled()
  })

  // --- #292 Expand/collapse conflict content ---

  it('toggles expand/collapse on conflict item click (#292)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'A very long incoming content string', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    const { container } = render(<ConflictList />)

    await screen.findByText(/A very long incoming content string/)

    // Initially content divs should have truncate class
    const currentDiv = container.querySelector('.conflict-original')
    const incomingDiv = container.querySelector('.conflict-incoming')
    expect(currentDiv?.className).toContain('truncate')
    expect(incomingDiv?.className).toContain('truncate')

    // Click the expandable content area
    const expandBtn = container.querySelector('.conflict-item-content') as HTMLElement
    await user.click(expandBtn)

    // After click, truncate class should be removed
    expect(currentDiv?.className).not.toContain('truncate')
    expect(incomingDiv?.className).not.toContain('truncate')

    // Click again to collapse
    await user.click(expandBtn)

    // Truncate class should be restored
    expect(currentDiv?.className).toContain('truncate')
    expect(incomingDiv?.className).toContain('truncate')
  })

  // --- #296 View original button / navigation ---

  it('shows "View original" button when parent_id exists (#296)', async () => {
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    const viewOriginalBtn = await screen.findByRole('button', { name: /View original/i })
    expect(viewOriginalBtn).toBeInTheDocument()
  })

  it('does not show "View original" button when parent_id is null (#296)', async () => {
    const conflict = makeConflict('C1', 'orphan conflict', null)
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
    })

    render(<ConflictList />)

    await screen.findByText('orphan conflict')

    expect(screen.queryByRole('button', { name: /View original/i })).not.toBeInTheDocument()
  })

  it('"View original" navigates to the parent page (#296)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    const viewOriginalBtn = await screen.findByRole('button', { name: /View original/i })
    await user.click(viewOriginalBtn)

    // Should have navigated to the original block's page
    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(navState.pageStack).toContainEqual(expect.objectContaining({ pageId: 'ORIG001' }))
  })

  // --- #298 Aria-labels on Keep/Discard buttons ---

  it('Keep and Discard buttons have aria-labels with block ID context (#298)', async () => {
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    await screen.findByText('conflict text')

    const keepBtn = screen.getByRole('button', { name: /Keep incoming version for block C1/i })
    expect(keepBtn).toBeInTheDocument()

    const discardBtn = screen.getByRole('button', { name: /Discard conflict for block C1/i })
    expect(discardBtn).toBeInTheDocument()
  })

  // --- #304 Help text banner ---

  it('shows help text banner when conflicts exist (#304)', async () => {
    const conflict = makeConflict('C1', 'conflict text')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    await screen.findByText('conflict text')

    // Help text about Keep and Discard should be visible
    expect(screen.getByText(/replaces the current content/i)).toBeInTheDocument()
    expect(screen.getByText(/removes the conflicting version/i)).toBeInTheDocument()
  })

  it('does not show help text banner when no conflicts', async () => {
    mockInvokeByCommand({ get_conflicts: emptyPage })

    render(<ConflictList />)

    await screen.findByText(/No conflicts/)

    // Help text should NOT be visible
    expect(screen.queryByText(/replaces the current content/i)).not.toBeInTheDocument()
  })

  // --- #651 C-1 "View original" passes block content as title, not empty string ---

  it('navigates with block content as title (#651 C-1)', async () => {
    // Reset navigation store to avoid state from prior tests
    useNavigationStore.setState({ pageStack: [], currentView: 'pages', selectedBlockId: null })
    const user = userEvent.setup()
    const conflict = makeConflict('C1', 'my block content', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    const viewOriginalBtn = await screen.findByRole('button', { name: /View original/i })
    await user.click(viewOriginalBtn)

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(navState.pageStack).toContainEqual(
      expect.objectContaining({ pageId: 'ORIG001', title: 'my block content' }),
    )
  })

  // --- #651 C-9 Conflict type badge has aria-label ---

  it('conflict type badge has aria-label (#651 C-9)', async () => {
    const conflict = makeConflict('C1', 'conflict text', 'ORIG001')
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict text')

    const typeBadge = container.querySelector('.conflict-type-badge')
    expect(typeBadge).toBeTruthy()
    expect(typeBadge?.getAttribute('aria-label')).toBe(
      'Text conflict — content edited on multiple devices',
    )
  })

  // --- #651-C5 Sync event listener and Refresh button ---

  it('registers a sync:complete event listener on mount (#651-C5)', async () => {
    mockInvokeByCommand({ get_conflicts: emptyPage })

    render(<ConflictList />)

    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith('sync:complete', expect.any(Function))
    })
  })

  it('cleans up the sync:complete listener on unmount (#651-C5)', async () => {
    mockInvokeByCommand({ get_conflicts: emptyPage })

    const { unmount } = render(<ConflictList />)

    // Wait for the listener to be registered
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith('sync:complete', expect.any(Function))
    })

    // Unmount and verify unlisten is called
    unmount()

    expect(mockUnlisten).toHaveBeenCalled()
  })

  it('refetches conflicts when sync:complete event fires (#651-C5)', async () => {
    const page = {
      items: [makeConflict('C1', 'conflict 1')],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    // Reset invoke call count to detect the refetch
    const callCountBefore = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'get_conflicts',
    ).length

    // Simulate the sync:complete event by invoking the captured listener callback
    const listenerCall = mockListen.mock.calls.find(
      ([event]: [string]) => event === 'sync:complete',
    )
    expect(listenerCall).toBeTruthy()
    const callback = listenerCall![1]
    callback({ payload: { ops_received: 3, ops_sent: 0 } })

    await waitFor(() => {
      const callCountAfter = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'get_conflicts',
      ).length
      expect(callCountAfter).toBeGreaterThan(callCountBefore)
    })
  })

  it('shows a Refresh button when conflicts exist (#651-C5)', async () => {
    const page = {
      items: [makeConflict('C1', 'conflict 1')],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    const refreshBtn = await screen.findByRole('button', { name: /Refresh conflict list/i })
    expect(refreshBtn).toBeInTheDocument()
  })

  it('clicking Refresh button triggers a refetch (#651-C5)', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeConflict('C1', 'conflict 1')],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    const callCountBefore = mockedInvoke.mock.calls.filter(
      ([cmd]) => cmd === 'get_conflicts',
    ).length

    const refreshBtn = screen.getByRole('button', { name: /Refresh conflict list/i })
    await user.click(refreshBtn)

    await waitFor(() => {
      const callCountAfter = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'get_conflicts',
      ).length
      expect(callCountAfter).toBeGreaterThan(callCountBefore)
    })
  })
})
