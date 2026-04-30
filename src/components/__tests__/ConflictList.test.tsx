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
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ulidToDate } from '@/lib/format'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { emptyPage, makeConflict } from '../../__tests__/fixtures'
import { announce } from '../../lib/announcer'
import { useNavigationStore } from '../../stores/navigation'
import { selectPageStack, useTabsStore } from '../../stores/tabs'
import { ConflictList } from '../ConflictList'
import { renderRichContent } from '../RichContentRenderer'

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

vi.mock('../../lib/announcer', () => ({
  announce: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
    chars.unshift(CROCKFORD[ts % 32] as string)
    ts = Math.floor(ts / 32)
  }
  return `${chars.join('')}AAAAAAAAAAAAAAAA`
}

const originalBlock = {
  id: 'ORIG001',
  block_type: 'content',
  content: 'original content',
  parent_id: null,
  position: null,
  deleted_at: null,
  is_conflict: false,
  conflict_type: null,
}

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

  it('logs a warning when the sync:complete listener cannot be installed', async () => {
    mockListen.mockRejectedValueOnce(new Error('not in tauri'))
    mockInvokeByCommand({ get_conflicts: emptyPage })

    render(<ConflictList />)

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'ConflictList',
      expect.stringContaining('sync:complete'),
      undefined,
      expect.any(Error),
    )
  })

  it('shows loading skeleton with aria-busy during initial load', () => {
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<ConflictList />)

    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
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
      items: [
        makeConflict({ id: 'C1', content: 'conflict content 1' }),
        makeConflict({ id: 'C2', content: 'conflict content 2' }),
      ],
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
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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
    expect(screen.getByText(t('conflict.keepIncomingTitle'))).toBeInTheDocument()

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
    const conflict = makeConflict({ id: 'C1', content: 'to discard' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    // First click: shows confirmation (use aria-label to avoid matching content button)
    const discardBtn = await screen.findByRole('button', { name: /Discard conflict for block/i })
    await user.click(discardBtn)

    expect(screen.getByText(t('conflict.discardTitle'))).toBeInTheDocument()

    // delete_block should NOT have been called yet
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())

    // Clicking "No" cancels
    const noBtn = screen.getByRole('button', { name: /No/i })
    await user.click(noBtn)

    expect(screen.queryByText(t('conflict.discardTitle'))).not.toBeInTheDocument()
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())
  })

  it('pressing Escape dismisses the discard confirmation', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'to discard' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    // First click: shows confirmation (use aria-label to avoid matching content button)
    const discardBtn = await screen.findByRole('button', { name: /Discard conflict for block/i })
    await user.click(discardBtn)

    expect(screen.getByText(t('conflict.discardTitle'))).toBeInTheDocument()

    // Press Escape to dismiss
    await user.keyboard('{Escape}')

    expect(screen.queryByText(t('conflict.discardTitle'))).not.toBeInTheDocument()
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())
  })

  it('Discard executes on confirmation Yes click', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'to discard' })
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
    const conflict = makeConflict({ id: 'C1', content: 'will be discarded' })
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
      items: [makeConflict({ id: 'C1', content: 'conflict 1' })],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    mockInvokeByCommand({ get_conflicts: page1, get_block: originalBlock })

    render(<ConflictList />)

    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()
    // Verify shared LoadMoreButton is used (aria-busy attribute)
    expect(loadMoreBtn).toHaveAttribute('aria-busy', 'false')
  })

  it('loads next page with cursor when Load More is clicked', async () => {
    const user = userEvent.setup()
    const page1 = {
      items: [makeConflict({ id: 'C1', content: 'conflict 1' })],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    const page2 = {
      items: [makeConflict({ id: 'C2', content: 'conflict 2' })],
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
    const conflict = makeConflict({ id: 'C1', content: 'will be kept' })
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
      items: [makeConflict({ id: 'C1', content: 'accessible conflict' })],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await waitFor(async () => {
      const results = await axe(document.body, {
        rules: {
          region: { enabled: false },
        },
      })
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations when empty', async () => {
    mockInvokeByCommand({ get_conflicts: emptyPage })

    render(<ConflictList />)

    await waitFor(async () => {
      const results = await axe(document.body, {
        rules: {
          region: { enabled: false },
        },
      })
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
      expect(toast.error).toHaveBeenCalledWith(t('conflict.loadFailed'))
    })
  })

  it('shows toast on failed Keep action with backend error text (#281)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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
      expect(toast.error).toHaveBeenCalledWith(
        t('conflict.resolveError', { error: 'permission denied' }),
      )
    })
  })

  it('shows toast on failed Discard action with backend error text (#281)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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
      expect(toast.error).toHaveBeenCalledWith(t('conflict.discardError', { error: 'db locked' }))
    })
  })

  it('shows success toast after successful Keep', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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
      expect(toast.success).toHaveBeenCalledWith(
        t('conflict.keptSelectedVersion'),
        expect.objectContaining({
          action: expect.objectContaining({ label: t('conflict.undoButton') }),
        }),
      )
    })
  })

  it('shows success toast after successful Discard', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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
      expect(toast.success).toHaveBeenCalledWith(
        t('conflict.conflictDiscarded'),
        expect.objectContaining({
          action: expect.objectContaining({ label: t('conflict.undoButton') }),
        }),
      )
    })
  })

  it('Keep with null parent_id only deletes the conflict (skips editBlock)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'orphan conflict', parent_id: null })
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
    const conflict = makeConflict({ id: 'C1', content: 'new version' })
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
        is_conflict: false,
        conflict_type: null,
      },
    })

    render(<ConflictList />)

    // "Current:" label + original content. Under React 19 the `Current:`
    // label appears as soon as the conflict row mounts, but the original
    // block content comes from a separate `get_block` call whose state
    // update is flushed on a later microtask — wait for that separately.
    expect(await screen.findByText('Current:')).toBeInTheDocument()
    expect(await screen.findByText('old version')).toBeInTheDocument()

    // "Incoming:" label + conflict content
    expect(screen.getByText('Incoming:')).toBeInTheDocument()
    expect(screen.getByText('new version')).toBeInTheDocument()

    // Verify get_block was called with the parent_id
    expect(mockedInvoke).toHaveBeenCalledWith('get_block', { blockId: 'ORIG001' })
  })

  it('shows fallback text when original block fetch fails', async () => {
    const conflict = makeConflict({ id: 'C1', content: 'conflict text', parent_id: 'ORIG_GONE' })
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
    expect(await screen.findByText(t('conflict.originalNotAvailable'))).toBeInTheDocument()

    // Incoming content is still shown
    expect(screen.getByText('conflict text')).toBeInTheDocument()
  })

  it('Keep confirmation dialog opens on Keep click', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Dialog should be visible
    expect(screen.getByText(t('conflict.keepIncomingTitle'))).toBeInTheDocument()
    expect(
      screen.getByText(/This will replace the current content with the incoming version\./),
    ).toBeInTheDocument()

    // edit_block/delete_block should NOT have been called yet
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())
  })

  it('Keep confirmation dialog completes the operation on confirm', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'incoming text' })
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
    expect(screen.getByText(t('conflict.keepIncomingTitle'))).toBeInTheDocument()

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
    expect(toast.success).toHaveBeenCalledWith(
      t('conflict.keptSelectedVersion'),
      expect.objectContaining({
        action: expect.objectContaining({ label: t('conflict.undoButton') }),
      }),
    )
  })

  it('Keep confirmation dialog can be cancelled', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    // Open Keep confirmation
    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)
    expect(screen.getByText(t('conflict.keepIncomingTitle'))).toBeInTheDocument()

    // Cancel
    const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
    await user.click(cancelBtn)

    // Dialog should be dismissed
    expect(screen.queryByText(t('conflict.keepIncomingTitle'))).not.toBeInTheDocument()

    // No edit/delete calls
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
    expect(mockedInvoke).not.toHaveBeenCalledWith('delete_block', expect.anything())

    // Conflict is still in the list
    expect(screen.getByText('conflict text')).toBeInTheDocument()
  })

  // --- Tests for conflict type badges and metadata (#224) ---

  it('renders conflict type badge with "Text" for each conflict', async () => {
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict content 1' }),
        makeConflict({ id: 'C2', content: 'conflict content 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict content 1')

    // Each conflict item should have a "Text" conflict type badge
    const typeBadges = container.querySelectorAll('.conflict-type-badge')
    expect(typeBadges).toHaveLength(2)
    expect(typeBadges[0]?.textContent).toBe('Text')
    expect(typeBadges[1]?.textContent).toBe('Text')
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
          is_conflict: false,
          conflict_type: null,
        }
      return null
    })
    const { container } = render(<ConflictList />)
    await waitFor(() => {
      expect(container.querySelector('.conflict-type-badge')).toBeInTheDocument()
    })
    const badge = container.querySelector('.conflict-type-badge')
    expect(badge?.textContent).toBe('Property')
    expect(badge?.className).toContain('bg-status-active')
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
          is_conflict: false,
          conflict_type: null,
        }
      return null
    })
    const { container } = render(<ConflictList />)
    await waitFor(() => {
      expect(container.querySelector('.conflict-type-badge')).toBeInTheDocument()
    })
    const badge = container.querySelector('.conflict-type-badge')
    expect(badge?.textContent).toBe('Move')
    expect(badge?.className).toContain('bg-conflict-move')
  })

  it('displays conflict metadata: source block ID (truncated)', async () => {
    const conflict = makeConflict({ id: 'CONFLICT-ID-VERY-LONG-1234', content: 'conflict text' })
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
    expect(sourceId).toBeInTheDocument()
    expect(sourceId?.textContent).toContain('ID:')
    expect(sourceId?.textContent).toContain('CONFLICT-ID-...')
  })

  it('displays conflict metadata: timestamp from ULID (#285)', async () => {
    // Create a ULID encoding a known timestamp
    const knownTs = Date.now() - 3600_000 // 1 hour ago
    const ulidId = makeUlid(knownTs)
    const conflict = makeConflict({ id: ulidId, content: 'conflict text' })
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
    expect(timestamp).toBeInTheDocument()
    expect(timestamp?.textContent).not.toBe('')
    expect(timestamp?.textContent).not.toBe('Unknown')
    // Should show something like "1h ago"
    expect(timestamp?.textContent).toMatch(/ago|Just now/i)
  })

  it('shows "Unknown" timestamp when block ID is not a valid ULID', async () => {
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
    const page = {
      items: [conflict],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict text')

    const timestamp = container.querySelector('.conflict-timestamp')
    expect(timestamp).toBeInTheDocument()
    expect(timestamp?.textContent).toBe('Unknown')
  })

  it('conflict type badge has amber styling for Text type', async () => {
    const page = {
      items: [makeConflict({ id: 'C1', content: 'conflict content' })],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict content')

    const typeBadge = container.querySelector('.conflict-type-badge')
    expect(typeBadge).toBeInTheDocument()
    expect(typeBadge?.className).toContain('bg-conflict-text')
    expect(typeBadge?.className).toContain('text-conflict-text-foreground')
  })

  it('Keep/Discard flow still works with badges and metadata present', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict with badge' })
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
    const conflict = makeConflict({ id: 'C1', content: 'incoming changes' })
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
        t('conflict.updateSuccessDeleteFailed'),
        expect.objectContaining({
          action: expect.objectContaining({ label: t('conflict.retryDeleteButton') }),
        }),
      )
    })

    // Should NOT show an error toast (editBlock succeeded)
    expect(toast.error).not.toHaveBeenCalled()
  })

  // --- #292 Expand/collapse conflict content ---

  it('toggles expand/collapse on conflict item click (#292)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'A very long incoming content string' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    const { container } = render(<ConflictList />)

    await screen.findByText(/A very long incoming content string/)

    // Initially content divs should have truncate class
    expect(container.querySelector('.conflict-original')?.className).toContain('truncate')
    expect(container.querySelector('.conflict-incoming')?.className).toContain('truncate')

    // Click the expandable content area
    const expandBtn = container.querySelector('.conflict-item-content') as HTMLElement
    await user.click(expandBtn)

    // After click, truncate class should be removed (now wrapped in ScrollArea)
    const expandedOriginal = container.querySelector('.conflict-original')
    const expandedIncoming = container.querySelector('.conflict-incoming')
    expect(expandedOriginal?.className).not.toContain('truncate')
    expect(expandedIncoming?.className).not.toContain('truncate')
    expect((expandedOriginal as HTMLElement)?.dataset['slot']).toBe('scroll-area')
    expect((expandedIncoming as HTMLElement)?.dataset['slot']).toBe('scroll-area')

    // Click again to collapse
    await user.click(expandBtn)

    // Truncate class should be restored
    expect(container.querySelector('.conflict-original')?.className).toContain('truncate')
    expect(container.querySelector('.conflict-incoming')?.className).toContain('truncate')
  })

  // --- #296 View original button / navigation ---

  it('shows "View original" button when parent_id exists (#296)', async () => {
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    const viewOriginalBtn = await screen.findByRole('button', { name: /View original/i })
    expect(viewOriginalBtn).toBeInTheDocument()
  })

  it('does not show "View original" button when parent_id is null (#296)', async () => {
    const conflict = makeConflict({ id: 'C1', content: 'orphan conflict', parent_id: null })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
    })

    render(<ConflictList />)

    await screen.findByText('orphan conflict')

    expect(screen.queryByRole('button', { name: /View original/i })).not.toBeInTheDocument()
  })

  it('"View original" navigates to the parent page (#296)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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
    expect(selectPageStack(useTabsStore.getState())).toContainEqual(
      expect.objectContaining({ pageId: 'ORIG001' }),
    )
  })

  // --- #298 Aria-labels on Keep/Discard buttons ---

  it('Keep and Discard buttons have aria-labels with block ID context (#298)', async () => {
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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
    useNavigationStore.setState({
      currentView: 'pages',
      selectedBlockId: null,
    })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
    })
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'my block content' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    const viewOriginalBtn = await screen.findByRole('button', { name: /View original/i })
    await user.click(viewOriginalBtn)

    const navState = useNavigationStore.getState()
    expect(navState.currentView).toBe('page-editor')
    expect(selectPageStack(useTabsStore.getState())).toContainEqual(
      expect.objectContaining({ pageId: 'ORIG001', title: 'my block content' }),
    )
  })

  // --- #651 C-9 Conflict type badge has aria-label ---

  it('conflict type badge has aria-label (#651 C-9)', async () => {
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    const { container } = render(<ConflictList />)

    await screen.findByText('conflict text')

    const typeBadge = container.querySelector('.conflict-type-badge')
    expect(typeBadge).toBeInTheDocument()
    expect(typeBadge?.getAttribute('aria-label')).toBe(t('conflict.typeText'))
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
      items: [makeConflict({ id: 'C1', content: 'conflict 1' })],
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
    const listenerCall = mockListen.mock.calls.find(([event]) => event === 'sync:complete')
    expect(listenerCall).toBeDefined()
    const callback = listenerCall?.[1]
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
      items: [makeConflict({ id: 'C1', content: 'conflict 1' })],
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
      items: [makeConflict({ id: 'C1', content: 'conflict 1' })],
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

  // --- #651 C-6 Content preview in Keep/Discard confirmation dialogs ---

  it('Keep dialog shows content preview of original and incoming (#651 C-6)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'incoming changes' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    // Wait for original to be fetched
    await screen.findByText('original content')

    // Open Keep dialog
    const keepBtn = screen.getByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    // Dialog should show content preview
    const dialog = document.querySelector('.conflict-keep-confirm')
    expect(dialog).toBeInTheDocument()
    expect(dialog?.textContent).toContain('incoming changes')
    expect(dialog?.textContent).toContain('original content')
  })

  it('Keep dialog exposes confirm/yes/no testids matching the discard pattern (TEST-1c)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'incoming changes' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)
    await screen.findByText('incoming changes')

    // Dialog closed initially — no test-ids visible
    expect(screen.queryByTestId('conflict-keep-confirm')).toBeNull()
    expect(screen.queryByTestId('conflict-keep-yes')).toBeNull()
    expect(screen.queryByTestId('conflict-keep-no')).toBeNull()

    // Open Keep confirmation
    await user.click(screen.getByRole('button', { name: /Keep/i }))

    // Root content carries conflict-keep-confirm, and cancel/action buttons
    // carry conflict-keep-no / conflict-keep-yes respectively. These mirror
    // the conflict-discard-{confirm,yes,no} scheme and unblock the
    // e2e/conflict-resolution.spec.ts "Keep button" test (TEST-1c).
    const confirmRoot = screen.getByTestId('conflict-keep-confirm')
    expect(confirmRoot).toBeInTheDocument()
    expect(confirmRoot.classList.contains('conflict-keep-confirm')).toBe(true)

    const yesBtn = screen.getByTestId('conflict-keep-yes')
    expect(yesBtn).toBeInTheDocument()
    expect(yesBtn.tagName).toBe('BUTTON')

    const noBtn = screen.getByTestId('conflict-keep-no')
    expect(noBtn).toBeInTheDocument()
    expect(noBtn.tagName).toBe('BUTTON')
  })

  it('Discard dialog shows content preview of conflict (#651 C-6)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict to discard' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    await screen.findByText('conflict to discard')

    // Open Discard dialog
    const discardBtn = screen.getByRole('button', { name: /Discard conflict for block/i })
    await user.click(discardBtn)

    // Dialog should show content preview
    const dialog = document.querySelector('.conflict-discard-confirm')
    expect(dialog).toBeInTheDocument()
    expect(dialog?.textContent).toContain('conflict to discard')
  })

  it('Keep dialog truncates long content in preview (#651 C-6)', async () => {
    const user = userEvent.setup()
    const longContent = 'A'.repeat(200)
    const conflict = makeConflict({ id: 'C1', content: longContent })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    render(<ConflictList />)

    await screen.findByText(/AAAA/)

    const keepBtn = screen.getByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    const dialog = document.querySelector('.conflict-keep-confirm')
    // Should contain truncated content (120 chars + ellipsis), not full 200 chars
    const dialogText = dialog?.textContent ?? ''
    expect(dialogText).toContain('A'.repeat(120))
    expect(dialogText).toContain('\u2026')
    expect(dialogText).not.toContain('A'.repeat(200))
  })

  // --- C-12 Rich content rendering ---

  it('renders conflict content as rich text (C-12)', async () => {
    const mockedRender = vi.mocked(renderRichContent)
    mockedRender.mockClear()

    const conflict = makeConflict({ id: 'C1', content: '**bold** text' })
    const origWithMarkdown = {
      ...originalBlock,
      content: '*italic* content',
    }
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: origWithMarkdown,
    })

    render(<ConflictList />)

    await waitFor(() => {
      expect(mockedRender).toHaveBeenCalledWith(
        '**bold** text',
        expect.objectContaining({ interactive: true }),
      )
      expect(mockedRender).toHaveBeenCalledWith(
        '*italic* content',
        expect.objectContaining({ interactive: true }),
      )
    })
  })

  // --- C-16 Partial failure retry ---

  it('partial failure toast includes retry action (C-16)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'incoming changes' })
    let deleteCallCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return { items: [conflict], next_cursor: null, has_more: false }
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'edit_block')
        return { id: 'ORIG001', block_type: 'content', content: 'incoming changes' }
      if (cmd === 'delete_block') {
        deleteCallCount++
        if (deleteCallCount === 1) throw new Error('storage full')
        return {
          block_id: 'C1',
          deleted_at: '2025-01-15T00:00:00Z',
          descendants_affected: 0,
        }
      }
      return undefined
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    // Verify partial failure toast with retry action
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        t('conflict.updateSuccessDeleteFailed'),
        expect.objectContaining({
          action: expect.objectContaining({ label: t('conflict.retryDeleteButton') }),
        }),
      )
    })

    // Extract and invoke the retry action
    const successCalls = vi.mocked(toast.success).mock.calls
    const retryCall = successCalls.find(([msg]) => msg === t('conflict.updateSuccessDeleteFailed'))
    expect(retryCall).toBeDefined()
    // biome-ignore lint/suspicious/noExplicitAny: test mock extraction
    const retryAction = (retryCall?.[1] as any).action
    retryAction.onClick()

    // Verify deleteBlock was called again
    await waitFor(() => {
      expect(deleteCallCount).toBe(2)
    })
  })

  // --- C-4 Undo support ---

  it('Keep toast includes undo action (C-4)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
      edit_block: { id: 'ORIG001', block_type: 'content', content: 'conflict text' },
      delete_block: {
        block_id: 'C1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
      },
      restore_block: { block_id: 'C1', restored_at: '2026-01-01T00:00:01Z' },
    })

    render(<ConflictList />)

    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)

    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    // Verify toast has Undo action
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        t('conflict.keptSelectedVersion'),
        expect.objectContaining({
          action: expect.objectContaining({ label: t('conflict.undoButton') }),
        }),
      )
    })

    // Extract and invoke the undo action
    const successCalls = vi.mocked(toast.success).mock.calls
    const undoCall = successCalls.find(([msg]) => msg === t('conflict.keptSelectedVersion'))
    expect(undoCall).toBeDefined()
    // biome-ignore lint/suspicious/noExplicitAny: test mock extraction
    const undoAction = (undoCall?.[1] as any).action
    undoAction.onClick()

    // Verify restoreBlock and editBlock were called to reverse
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restore_block', {
        blockId: 'C1',
        deletedAtRef: '2026-01-01T00:00:00Z',
      })
    })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'ORIG001',
        toText: 'original content',
      })
    })
  })

  it('Discard toast includes undo action (C-4)', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict to discard' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
      delete_block: {
        block_id: 'C1',
        deleted_at: '2026-01-01T00:00:00Z',
        descendants_affected: 0,
      },
      restore_block: { block_id: 'C1', restored_at: '2026-01-01T00:00:01Z' },
    })

    render(<ConflictList />)

    const discardBtn = await screen.findByRole('button', {
      name: /Discard conflict for block/i,
    })
    await user.click(discardBtn)

    const yesBtn = screen.getByRole('button', { name: /Yes, discard/i })
    await user.click(yesBtn)

    // Verify toast has Undo action
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        t('conflict.conflictDiscarded'),
        expect.objectContaining({
          action: expect.objectContaining({ label: t('conflict.undoButton') }),
        }),
      )
    })

    // Extract and invoke the undo action
    const successCalls = vi.mocked(toast.success).mock.calls
    const undoCall = successCalls.find(([msg]) => msg === t('conflict.conflictDiscarded'))
    expect(undoCall).toBeDefined()
    // biome-ignore lint/suspicious/noExplicitAny: test mock extraction
    const undoAction = (undoCall?.[1] as any).action
    undoAction.onClick()

    // Verify restoreBlock was called with the right args
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restore_block', {
        blockId: 'C1',
        deletedAtRef: '2026-01-01T00:00:00Z',
      })
    })
  })

  // --- #651 C-2 Type-specific rendering ---

  it('renders property diff for Property conflict type (#651 C-2)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    vi.mocked(invoke).mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_conflicts') {
        return {
          items: [
            {
              id: 'CPROP1',
              block_type: 'content',
              content: 'same content',
              parent_id: 'ORIG_PROP',
              position: 1,
              deleted_at: null,
              is_conflict: true,
              conflict_type: 'Property',
              todo_state: 'DONE',
              priority: 'A',
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'get_block') {
        return {
          id: 'ORIG_PROP',
          block_type: 'content',
          content: 'same content',
          parent_id: null,
          position: 1,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: 'TODO',
          priority: 'B',
          due_date: null,
          scheduled_date: null,
        }
      }
      return null
    })

    const { container } = render(<ConflictList />)

    await waitFor(() => {
      expect(container.querySelector('.conflict-property-diff')).toBeInTheDocument()
    })

    expect(screen.getByText(t('conflict.propertyChanges'))).toBeInTheDocument()
    expect(screen.getByText(/State:/)).toBeInTheDocument()
    expect(screen.getByText(/Priority:/)).toBeInTheDocument()
  })

  it('renders move diff for Move conflict type (#651 C-2)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    vi.mocked(invoke).mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_conflicts') {
        return {
          items: [
            {
              id: 'CMOVE1',
              block_type: 'content',
              content: 'moved block',
              parent_id: 'NEW_PARENT',
              position: 3,
              deleted_at: null,
              is_conflict: true,
              conflict_type: 'Move',
              todo_state: null,
              priority: null,
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'get_block') {
        return {
          id: 'NEW_PARENT',
          block_type: 'content',
          content: 'moved block',
          parent_id: 'OLD_PARENT',
          position: 1,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: null,
          priority: null,
          due_date: null,
          scheduled_date: null,
        }
      }
      return null
    })

    const { container } = render(<ConflictList />)

    await waitFor(() => {
      expect(container.querySelector('.conflict-move-diff')).toBeInTheDocument()
    })

    expect(screen.getByText(t('conflict.moveConflictHeader'))).toBeInTheDocument()
    expect(screen.getByText(/Parent:/)).toBeInTheDocument()
  })

  it('falls back to text rendering when Property conflict has no detectable diffs (#651 C-2)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
    vi.mocked(invoke).mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'get_conflicts') {
        return {
          items: [
            {
              id: 'CPROP_SAME',
              block_type: 'content',
              content: 'identical content',
              parent_id: 'ORIG_SAME',
              position: 1,
              deleted_at: null,
              is_conflict: true,
              conflict_type: 'Property',
              todo_state: 'TODO',
              priority: 'A',
              due_date: null,
              scheduled_date: null,
            },
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'get_block') {
        return {
          id: 'ORIG_SAME',
          block_type: 'content',
          content: 'identical content',
          parent_id: null,
          position: 1,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
          todo_state: 'TODO',
          priority: 'A',
          due_date: null,
          scheduled_date: null,
        }
      }
      return null
    })

    const { container } = render(<ConflictList />)

    await waitFor(() => {
      expect(screen.getByText('Current:')).toBeInTheDocument()
    })

    expect(screen.getByText('Incoming:')).toBeInTheDocument()
    expect(container.querySelector('.conflict-property-diff')).toBeNull()
  })

  // --- #651 C-8 Batch resolution ---

  it('shows batch toolbar when conflicts are selected (#651 C-8)', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    // Click first checkbox
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)

    expect(screen.getByText(t('batch.selectedCount', { count: 1 }))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Keep all/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Discard all/i })).toBeInTheDocument()
  })

  it('select all selects all conflicts (#651 C-8)', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    // Select one to show toolbar
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)

    // Click "Select all"
    const selectAllBtn = screen.getByRole('button', { name: /Select all/i })
    await user.click(selectAllBtn)

    expect(screen.getByText(t('batch.selectedCount', { count: 2 }))).toBeInTheDocument()

    // All checkboxes should be checked
    const allCheckboxes = screen.getAllByRole('checkbox')
    for (const cb of allCheckboxes) {
      expect(cb).toBeChecked()
    }
  })

  it('batch keep confirms and resolves selected conflicts (#651 C-8)', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({
      get_conflicts: page,
      get_block: originalBlock,
      edit_block: { id: 'ORIG001', block_type: 'content', content: 'conflict 1' },
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    // Select both conflicts
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    expect(screen.getByText(t('batch.selectedCount', { count: 2 }))).toBeInTheDocument()

    // Click "Keep all"
    const keepAllBtn = screen.getByRole('button', { name: /Keep all/i })
    await user.click(keepAllBtn)

    // Confirm dialog
    expect(screen.getByText(t('conflict.keepAllSelectedTitle'))).toBeInTheDocument()
    const confirmBtn = screen.getByRole('button', { name: /Yes, keep all/i })
    await user.click(confirmBtn)

    // Verify API calls for both
    await waitFor(() => {
      const editCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'edit_block')
      const deleteCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_block')
      expect(editCalls.length).toBeGreaterThanOrEqual(2)
      expect(deleteCalls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('batch discard confirms and removes selected conflicts (#651 C-8)', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
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

    await screen.findByText('conflict 1')

    // Select both conflicts
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    // Click "Discard all"
    const discardAllBtn = screen.getByRole('button', { name: /Discard all/i })
    await user.click(discardAllBtn)

    // Confirm dialog
    expect(screen.getByText(t('conflict.discardAllSelectedTitle'))).toBeInTheDocument()
    const confirmBtn = screen.getByRole('button', { name: /Yes, discard all/i })
    await user.click(confirmBtn)

    // Verify deleteBlock called for each
    await waitFor(() => {
      const deleteCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_block')
      expect(deleteCalls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('batch toolbar hidden when no selection (#651 C-8)', async () => {
    const page = {
      items: [makeConflict({ id: 'C1', content: 'conflict 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Keep all/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Discard all/i })).not.toBeInTheDocument()
  })

  it('a11y: no violations with batch toolbar visible (#651 C-8)', async () => {
    const user = userEvent.setup()
    const page = {
      items: [makeConflict({ id: 'C1', content: 'conflict 1' })],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    // Select a conflict to show toolbar
    const checkbox = screen.getAllByRole('checkbox')[0] as HTMLElement
    await user.click(checkbox)

    expect(screen.getByText(t('batch.selectedCount', { count: 1 }))).toBeInTheDocument()

    await waitFor(async () => {
      const results = await axe(document.body, {
        rules: {
          region: { enabled: false },
        },
      })
      expect(results).toHaveNoViolations()
    })
  })

  it('shows partial failure toast when batch keep has mixed results (#651 C-8)', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    let editCallCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return page
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'edit_block') {
        editCallCount++
        if (editCallCount > 1) throw new Error('db locked')
        return { id: 'ORIG001', block_type: 'content', content: 'conflict 1' }
      }
      if (cmd === 'delete_block') {
        return { block_id: 'C1', deleted_at: '2025-01-15T00:00:00Z', descendants_affected: 0 }
      }
      return undefined
    })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    const keepAllBtn = screen.getByRole('button', { name: /Keep all/i })
    await user.click(keepAllBtn)

    const confirmBtn = screen.getByRole('button', { name: /Yes, keep all/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        t('conflict.batchError', { failCount: 1, count: 2 }),
        expect.objectContaining({ duration: 5000 }),
      )
    })
  })

  // --- #651 C-3 Source device info ---

  it('displays source device name for conflict blocks (#651 C-3)', async () => {
    const page = {
      items: [makeConflict({ id: 'C1', content: 'conflict content' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return page
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'get_block_history') {
        return {
          items: [
            {
              device_id: 'DEVICE_ABC',
              seq: 1,
              op_type: 'CreateBlock',
              payload: '{}',
              created_at: '2026-04-03T00:00:00Z',
            },
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'list_peer_refs') {
        return [
          {
            peer_id: 'DEVICE_ABC',
            device_name: 'Phone',
            synced_at: '2026-04-03T00:00:00Z',
            last_hash: null,
            last_sent_hash: null,
            reset_count: 0,
            last_reset_at: null,
            cert_hash: null,
          },
        ]
      }
      if (cmd === 'get_device_id') return 'DEVICE_LOCAL'
      return undefined
    })

    render(<ConflictList />)

    expect(await screen.findByText(/From: Phone/)).toBeInTheDocument()
  })

  it('shows truncated device ID when peer name not found (#651 C-3)', async () => {
    const page = {
      items: [makeConflict({ id: 'C2', content: 'unknown device' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return page
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'get_block_history') {
        return {
          items: [
            {
              device_id: 'UNKNOWN_DEVICE_ID_LONG',
              seq: 1,
              op_type: 'CreateBlock',
              payload: '{}',
              created_at: '2026-04-03T00:00:00Z',
            },
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'get_device_id') return 'DEVICE_LOCAL'
      return undefined
    })

    render(<ConflictList />)

    expect(await screen.findByText(/From: UNKNOWN_\.\.\./)).toBeInTheDocument()
  })

  it('shows "This device" for locally-created conflicts (#651 C-3)', async () => {
    const page = {
      items: [makeConflict({ id: 'C3', content: 'local conflict' })],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return page
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'get_block_history') {
        return {
          items: [
            {
              device_id: 'DEVICE_LOCAL',
              seq: 1,
              op_type: 'CreateBlock',
              payload: '{}',
              created_at: '2026-04-03T00:00:00Z',
            },
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'list_peer_refs') return []
      if (cmd === 'get_device_id') return 'DEVICE_LOCAL'
      return undefined
    })

    render(<ConflictList />)

    expect(await screen.findByText(/From: This device/)).toBeInTheDocument()
  })

  it('conflict action buttons container has flex-wrap for mobile', async () => {
    const page = {
      items: [makeConflict({ id: 'C1', content: 'wrap test' })],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('wrap test')

    const actionsContainer = document.querySelector('.conflict-item-actions')
    expect(actionsContainer).not.toBeNull()
    expect(actionsContainer?.className).toContain('flex-wrap')
  })

  it('conflict list container has role="grid" and items have role="row"', async () => {
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict one' }),
        makeConflict({ id: 'C2', content: 'conflict two' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict one')

    // Parent container should have role="grid"
    const list = screen.getByRole('grid', { name: 'Conflict list' })
    expect(list).toBeInTheDocument()
    expect(list.className).toContain('conflict-items')

    // Each conflict item should have role="row".
    // Under full-suite parallel load, items may not be in the tree when the
    // findByText above resolves (React 19 microtask timing — TEST-3 flake).
    // Use findAllByRole so the query retries until items render.
    const rows = await within(list).findAllByRole('row')
    expect(rows).toHaveLength(2)
    for (const item of rows) {
      expect(item.className).toContain('conflict-item')
    }
  })

  // --- Keyboard navigation ---

  it('ArrowDown moves focus to the next conflict item', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
        makeConflict({ id: 'C3', content: 'conflict 3' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    const grid = screen.getByRole('grid', { name: 'Conflict list' })
    expect(grid.getAttribute('aria-activedescendant')).toBe('conflict-C1')

    // Focus the grid and press ArrowDown
    grid.focus()
    await user.keyboard('{ArrowDown}')

    expect(grid.getAttribute('aria-activedescendant')).toBe('conflict-C2')

    await user.keyboard('{ArrowDown}')

    expect(grid.getAttribute('aria-activedescendant')).toBe('conflict-C3')
  })

  it('ArrowUp moves focus to the previous conflict item', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
        makeConflict({ id: 'C3', content: 'conflict 3' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    const grid = screen.getByRole('grid', { name: 'Conflict list' })

    // Focus and move down twice, then back up
    grid.focus()
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')
    expect(grid.getAttribute('aria-activedescendant')).toBe('conflict-C3')

    await user.keyboard('{ArrowUp}')
    expect(grid.getAttribute('aria-activedescendant')).toBe('conflict-C2')
  })

  it('ArrowDown wraps to the first item at the end of the list', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    const grid = screen.getByRole('grid', { name: 'Conflict list' })

    grid.focus()
    await user.keyboard('{ArrowDown}')
    expect(grid.getAttribute('aria-activedescendant')).toBe('conflict-C2')

    // Wrap around
    await user.keyboard('{ArrowDown}')
    expect(grid.getAttribute('aria-activedescendant')).toBe('conflict-C1')
  })

  it('Home/End keys jump to first/last item', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
        makeConflict({ id: 'C3', content: 'conflict 3' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    const grid = screen.getByRole('grid', { name: 'Conflict list' })

    grid.focus()
    await user.keyboard('{End}')
    expect(grid.getAttribute('aria-activedescendant')).toBe('conflict-C3')

    await user.keyboard('{Home}')
    expect(grid.getAttribute('aria-activedescendant')).toBe('conflict-C1')
  })

  it('Enter key on focused item toggles expand/collapse', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'expandable content' })
    mockInvokeByCommand({
      get_conflicts: { items: [conflict], next_cursor: null, has_more: false },
      get_block: originalBlock,
    })

    const { container } = render(<ConflictList />)

    await screen.findByText('expandable content')

    // Initially truncated
    expect(container.querySelector('.conflict-original')?.className).toContain('truncate')

    const grid = screen.getByRole('grid', { name: 'Conflict list' })
    grid.focus()
    await user.keyboard('{Enter}')

    // After Enter, should be expanded
    await waitFor(() => {
      expect(container.querySelector('.conflict-original')?.className).not.toContain('truncate')
    })
  })

  it('aria-selected reflects the currently focused item', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    // findAllByRole, not getAllByRole: items render asynchronously after the
    // initial findByText resolves under React 19 microtask timing. Matches
    // the TEST-3 fix applied to the grid-role test above.
    const grid = screen.getByRole('grid', { name: 'Conflict list' })
    const rows = await within(grid).findAllByRole('row')
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true')
    expect(rows[1]?.getAttribute('aria-selected')).toBe('false')

    grid.focus()
    await user.keyboard('{ArrowDown}')

    await waitFor(() => {
      expect(rows[0]?.getAttribute('aria-selected')).toBe('false')
      expect(rows[1]?.getAttribute('aria-selected')).toBe('true')
    })
  })

  // --- Screen reader announcements ---

  it('announces when a conflict is kept', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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

    const yesKeepBtn = screen.getByRole('button', { name: /Yes, keep/i })
    await user.click(yesKeepBtn)

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(t('conflict.resolvedAnnounce'))
    })
  })

  it('announces when a conflict is discarded', async () => {
    const user = userEvent.setup()
    const conflict = makeConflict({ id: 'C1', content: 'conflict text' })
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

    const discardBtn = await screen.findByRole('button', {
      name: /Discard conflict for block/i,
    })
    await user.click(discardBtn)

    const yesBtn = screen.getByRole('button', { name: /Yes, discard/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(t('conflict.discardedAnnounce'))
    })
  })

  it('announces after batch keep', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({
      get_conflicts: page,
      get_block: originalBlock,
      edit_block: { id: 'ORIG001', block_type: 'content', content: 'conflict 1' },
      delete_block: {
        block_id: 'C1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      },
    })

    render(<ConflictList />)

    await screen.findByText('conflict 1')

    // Select both conflicts
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    // Click "Keep all"
    const keepAllBtn = screen.getByRole('button', { name: /Keep all/i })
    await user.click(keepAllBtn)

    // Confirm
    const confirmBtn = screen.getByRole('button', { name: /Yes, keep all/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(t('conflict.batchKeptCount', { count: 2 }))
    })
  })

  it('announces after batch discard', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
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

    await screen.findByText('conflict 1')

    // Select both conflicts
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    // Click "Discard all"
    const discardAllBtn = screen.getByRole('button', { name: /Discard all/i })
    await user.click(discardAllBtn)

    // Confirm
    const confirmBtn = screen.getByRole('button', { name: /Yes, discard all/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(t('conflict.batchDiscardedCount', { count: 2 }))
    })
  })

  // --- UX-210: i18n aria-label ---
  it('grid aria-label resolves via t() (UX-210)', async () => {
    const page = {
      items: [makeConflict({ id: 'C1', content: 'i18n test' })],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    render(<ConflictList />)
    await screen.findByText('i18n test')

    const grid = screen.getByRole('grid', { name: t('conflicts.listLabel') })
    expect(grid).toBeInTheDocument()
  })

  // UX-259: destructive batch dialogs must not confirm on a reflex Enter.
  it('UX-259: reflex Enter on batch keep dialog does NOT call edit_block/delete_block', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({
      get_conflicts: page,
      get_block: originalBlock,
    })

    render(<ConflictList />)
    await screen.findByText('conflict 1')

    // Select both conflicts.
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    // Open the destructive "Keep all" batch dialog.
    await user.click(screen.getByRole('button', { name: /Keep all/i }))
    expect(screen.getByText(t('conflict.keepAllSelectedTitle'))).toBeInTheDocument()

    // Cancel is auto-focused for destructive — reflex Enter dismisses.
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.queryByText(t('conflict.keepAllSelectedTitle'))).not.toBeInTheDocument()
    })

    // No batch mutations should have fired.
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'edit_block')).toHaveLength(0)
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_block')).toHaveLength(0)
  })

  it('UX-259: reflex Enter on batch discard dialog does NOT call delete_block', async () => {
    const user = userEvent.setup()
    const page = {
      items: [
        makeConflict({ id: 'C1', content: 'conflict 1' }),
        makeConflict({ id: 'C2', content: 'conflict 2' }),
      ],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({
      get_conflicts: page,
      get_block: originalBlock,
    })

    render(<ConflictList />)
    await screen.findByText('conflict 1')

    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    // Open the destructive "Discard all" batch dialog.
    await user.click(screen.getByRole('button', { name: /Discard all/i }))
    expect(screen.getByText(t('conflict.discardAllSelectedTitle'))).toBeInTheDocument()

    // Cancel is auto-focused for destructive — reflex Enter dismisses.
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.queryByText(t('conflict.discardAllSelectedTitle'))).not.toBeInTheDocument()
    })

    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_block')).toHaveLength(0)
  })

  // UX-259: single-conflict destructive dialogs must also not confirm on a
  // reflex Enter — Keep replaces the original block with the conflict copy
  // (data loss), Discard permanently deletes the conflict block.
  it('UX-259: reflex Enter on single-conflict Keep dialog does NOT call edit_block/delete_block', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      get_conflicts: {
        items: [makeConflict({ id: 'C1', content: 'conflict text' })],
        next_cursor: null,
        has_more: false,
      },
      get_block: originalBlock,
    })

    render(<ConflictList />)
    const keepBtn = await screen.findByRole('button', { name: /Keep/i })
    await user.click(keepBtn)
    expect(screen.getByText(t('conflict.keepIncomingTitle'))).toBeInTheDocument()

    // Cancel is auto-focused for destructive — reflex Enter dismisses.
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.queryByText(t('conflict.keepIncomingTitle'))).not.toBeInTheDocument()
    })

    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'edit_block')).toHaveLength(0)
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_block')).toHaveLength(0)
  })

  it('UX-259: reflex Enter on single-conflict Discard dialog does NOT call delete_block', async () => {
    const user = userEvent.setup()
    mockInvokeByCommand({
      get_conflicts: {
        items: [makeConflict({ id: 'C1', content: 'to discard' })],
        next_cursor: null,
        has_more: false,
      },
      get_block: originalBlock,
    })

    render(<ConflictList />)
    const discardBtn = await screen.findByRole('button', { name: /Discard conflict for block/i })
    await user.click(discardBtn)
    expect(screen.getByText(t('conflict.discardTitle'))).toBeInTheDocument()

    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.queryByText(t('conflict.discardTitle'))).not.toBeInTheDocument()
    })

    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_block')).toHaveLength(0)
  })

  // UX-264: while a batch keep/discard is iterating through 50+ conflicts,
  // users should see "Resolving N of M…" rather than just a spinner.
  it('shows batch progress text while iterating (UX-264)', async () => {
    const user = userEvent.setup()
    const conflicts = [
      makeConflict({ id: 'C1', content: 'c1' }),
      makeConflict({ id: 'C2', content: 'c2' }),
      makeConflict({ id: 'C3', content: 'c3' }),
      makeConflict({ id: 'C4', content: 'c4' }),
      makeConflict({ id: 'C5', content: 'c5' }),
    ]
    const page = { items: conflicts, next_cursor: null, has_more: false }

    // Hold the FIRST delete_block so we can observe the progress mid-flight
    // before any block is removed (which would mutate the items list and
    // trigger useListMultiSelect's auto-clear effect).
    let resolveFirstDelete: (() => void) | undefined
    const firstDeletePromise = new Promise<{
      block_id: string
      deleted_at: string
      descendants_affected: number
    }>((resolve) => {
      resolveFirstDelete = () =>
        resolve({ block_id: 'C1', deleted_at: '2025-01-15T00:00:00Z', descendants_affected: 0 })
    })

    let deleteCount = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_conflicts') return page
      if (cmd === 'get_block') return originalBlock
      if (cmd === 'delete_block') {
        deleteCount++
        if (deleteCount === 1) return firstDeletePromise
        return { block_id: 'CX', deleted_at: '2025-01-15T00:00:00Z', descendants_affected: 0 }
      }
      return undefined
    })

    render(<ConflictList />)

    await screen.findByText('c1')

    // Select one then "Select all" to grab all five.
    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    const selectAllBtn = screen.getByRole('button', { name: /Select all/i })
    await user.click(selectAllBtn)

    // Open + confirm the Discard-all batch dialog (Discard path is simpler:
    // only delete_block is awaited per item, so the deferred-delete trick
    // pauses the loop deterministically).
    await user.click(screen.getByRole('button', { name: /Discard all/i }))
    expect(screen.getByText(t('conflict.discardAllSelectedTitle'))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Yes, discard all/i }))

    // The 1st delete is hung, so progress must show "Resolving 1 of 5…".
    const progress = await screen.findByTestId('conflict-batch-progress')
    expect(progress).toHaveTextContent(t('conflicts.batchProgress', { current: 1, total: 5 }))
    expect(progress.getAttribute('role')).toBe('status')
    expect(progress.getAttribute('aria-live')).toBe('polite')

    // Release the hung delete to let the rest finish.
    resolveFirstDelete?.()

    // Progress disappears once the batch completes.
    await waitFor(() => {
      expect(screen.queryByTestId('conflict-batch-progress')).not.toBeInTheDocument()
    })
  })

  // UX-198: the conflict-list toolbar header used to sit inside a
  // `sticky top-0` wrapper. It's now hoisted to the App-level outlet via
  // <ViewHeader>. The toolbar must still render (via ViewHeader's inline
  // fallback) but the stale sticky classes must be gone from the subtree.
  it('UX-198: no sticky top-0 wrapper, but toolbar still renders when conflicts exist', async () => {
    const page = {
      items: [makeConflict({ id: 'C1', content: 'sticky regression' })],
      next_cursor: null,
      has_more: false,
    }
    mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

    const { container } = render(<ConflictList />)
    await screen.findByText('sticky regression')

    // Refresh button from the header still renders.
    expect(screen.getByRole('button', { name: t('conflict.refreshLabel') })).toBeInTheDocument()
    // Old sticky wrapper is gone.
    const sticky = container.querySelector('.sticky.top-0')
    expect(sticky).toBeNull()
  })

  // -- UX-265 sub-fix 2: filter bar ---------------------------------------
  describe('UX-265 filter bar', () => {
    it('renders the filter bar when conflicts exist', async () => {
      const page = {
        items: [makeConflict({ id: 'C1', content: 'filter renders' })],
        next_cursor: null,
        has_more: false,
      }
      mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

      render(<ConflictList />)
      await screen.findByText('filter renders')

      expect(screen.getByTestId('conflict-filter-bar')).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: t('conflict.filterByType') })).toBeInTheDocument()
      expect(
        screen.getByRole('combobox', { name: t('conflict.filterByDevice') }),
      ).toBeInTheDocument()
      expect(screen.getByRole('combobox', { name: t('conflict.filterByDate') })).toBeInTheDocument()
    })

    it('does not render the filter bar when no conflicts', async () => {
      mockInvokeByCommand({ get_conflicts: emptyPage })

      render(<ConflictList />)
      await screen.findByText(/No conflicts/)

      expect(screen.queryByTestId('conflict-filter-bar')).not.toBeInTheDocument()
    })

    it('selecting a type filter hides non-matching conflicts', async () => {
      const user = userEvent.setup()
      // biome-ignore lint/suspicious/noExplicitAny: invoke args are dynamic per command
      vi.mocked(invoke).mockImplementation(async (cmd: string, _args?: any) => {
        if (cmd === 'get_conflicts') {
          return {
            items: [
              // Text conflict — its content text "text-conflict-row" is
              // shown verbatim by TextConflictView.
              {
                id: 'CTEXT01',
                block_type: 'content',
                content: 'text-conflict-row',
                parent_id: 'P1',
                position: 1,
                deleted_at: null,
                is_conflict: true,
                conflict_type: null,
                todo_state: null,
                priority: null,
                due_date: null,
                scheduled_date: null,
              },
              // Move conflict — no content shown; identify by data-testid
              // and the type badge instead.
              {
                id: 'CMOVE01',
                block_type: 'content',
                content: 'move-conflict-row',
                parent_id: 'P2',
                position: 2,
                deleted_at: null,
                is_conflict: true,
                conflict_type: 'Move',
                todo_state: null,
                priority: null,
                due_date: null,
                scheduled_date: null,
              },
            ],
            next_cursor: null,
            has_more: false,
          }
        }
        if (cmd === 'get_block') {
          return {
            id: 'P1',
            block_type: 'content',
            content: 'orig',
            parent_id: null,
            position: 1,
            deleted_at: null,
            is_conflict: false,
            conflict_type: null,
            todo_state: null,
            priority: null,
            due_date: null,
            scheduled_date: null,
          }
        }
        return null
      })

      const { container } = render(<ConflictList />)

      // Both conflicts must be rendered before we apply a filter — otherwise
      // we'd be observing the pre-render state, not the filter behaviour.
      await waitFor(() => {
        expect(screen.getAllByTestId('conflict-item')).toHaveLength(2)
      })
      // Text conflict's content is rendered.
      expect(screen.getByText('text-conflict-row')).toBeInTheDocument()
      // Move conflict's badge is rendered (Move conflicts don't show content).
      const typeBadges = container.querySelectorAll('.conflict-type-badge')
      const badgeTexts = Array.from(typeBadges).map((b) => b.textContent)
      expect(badgeTexts).toContain('Text')
      expect(badgeTexts).toContain('Move')

      // Radix Select falls back to a native <select> in jsdom (no pointer
      // events). Use userEvent.selectOptions on the labelled element.
      const typeFilter = screen.getByLabelText(t('conflict.filterByType')) as HTMLSelectElement
      await user.selectOptions(typeFilter, 'Move')

      // After filter: only the Move conflict remains.
      await waitFor(() => {
        expect(screen.getAllByTestId('conflict-item')).toHaveLength(1)
      })
      expect(screen.queryByText('text-conflict-row')).not.toBeInTheDocument()
      const remainingBadges = container.querySelectorAll('.conflict-type-badge')
      expect(remainingBadges).toHaveLength(1)
      expect(remainingBadges[0]?.textContent).toBe('Move')
    })

    it('shows a no-match message when filters reduce list to zero', async () => {
      const user = userEvent.setup()
      // Single Text conflict, then user selects "Move" filter → 0 matches.
      const page = {
        items: [makeConflict({ id: 'C1', content: 'only-text-row' })],
        next_cursor: null,
        has_more: false,
      }
      mockInvokeByCommand({ get_conflicts: page, get_block: originalBlock })

      render(<ConflictList />)
      await screen.findByText('only-text-row')

      const typeFilter = screen.getByLabelText(t('conflict.filterByType')) as HTMLSelectElement
      await user.selectOptions(typeFilter, 'Move')

      await waitFor(() => {
        expect(screen.getByTestId('conflict-no-match')).toBeInTheDocument()
      })
      expect(screen.getByText(t('conflict.noMatchingFilters'))).toBeInTheDocument()
      expect(screen.queryByText('only-text-row')).not.toBeInTheDocument()
    })
  })
})
