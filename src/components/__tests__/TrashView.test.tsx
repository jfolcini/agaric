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
 *  - Multi-select: checkbox renders, click toggles selection
 *  - Shift+Click range selection
 *  - Selection toolbar appears with correct count
 *  - Batch restore calls restoreBlock for each selected
 *  - Batch purge shows confirmation dialog
 *  - Original location breadcrumbs render with parent page title
 *  - Breadcrumbs show "(deleted page)" when parent is missing
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { keyFor, useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { TrashView } from '../TrashView'

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

const mockedInvoke = vi.mocked(invoke)

function makeBlock(id: string, content: string, deletedAt: string, parentId: string | null = null) {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: parentId,
    position: null,
    deleted_at: deletedAt,
    is_conflict: false,
  }
}

const emptyPage = { items: [], next_cursor: null, has_more: false }

/**
 * Helper: mock invoke to return items on list_blocks and empty [] on batch_resolve.
 * Returns the page so callers can reference it.
 */
function mockListAndResolve(items: ReturnType<typeof makeBlock>[], hasMore = false) {
  const page = {
    items,
    next_cursor: hasMore ? 'cursor_next' : null,
    has_more: hasMore,
  }
  mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
    if (cmd === 'list_blocks') return page
    if (cmd === 'batch_resolve') return []
    if (cmd === 'trash_descendant_counts') return {}
    return undefined
  })
  return page
}

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({ cache: new Map(), pagesList: [], version: 0, _preloaded: false })
  // FEAT-3p7 — `useResolveStore.set` keys entries by `${currentSpaceId}::${ulid}`.
  // Pin a deterministic test space so the `cache.get` assertions below
  // can compose the same prefix.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
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
        agenda: null,
        cursor: null,
        limit: 50,
        spaceId: 'SPACE_TEST',
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
    mockListAndResolve([
      makeBlock('B1', 'deleted item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'deleted item 2', '2025-01-14T00:00:00Z'),
    ])

    render(<TrashView />)

    // Wait for items to render
    expect(await screen.findByText('deleted item 1')).toBeInTheDocument()
    expect(screen.getByText('deleted item 2')).toBeInTheDocument()

    // Each item should have a restore button
    const restoreBtns = screen.getAllByTestId('trash-restore-btn')
    expect(restoreBtns).toHaveLength(2)

    // Each item should have a purge button
    const purgeBtns = screen.getAllByTestId('trash-purge-btn')
    expect(purgeBtns).toHaveLength(2)
  })

  it('restore calls restoreBlock with correct deleted_at_ref', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'item', '2025-01-15T12:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_block') return { block_id: 'B1', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)

    const restoreBtn = await screen.findByTestId('trash-restore-btn')
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
    mockListAndResolve([block])

    render(<TrashView />)

    // First click: should show confirmation, NOT call purge_block
    const purgeBtn = await screen.findByRole('button', { name: /^Purge$/i })
    await user.click(purgeBtn)

    // After first click, confirmation dialog should appear
    expect(screen.getByText('Permanently delete?')).toBeInTheDocument()

    // Clicking "No" should cancel
    const noBtn = screen.getByRole('button', { name: /No/i })
    await user.click(noBtn)

    expect(screen.queryByText('Permanently delete?')).not.toBeInTheDocument()
  })

  // UX-259: destructive dialogs must not confirm on a reflex Enter on open.
  it('UX-259: reflex Enter on purge dialog dismisses without calling purgeBlock', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'to purge', '2025-01-15T00:00:00Z')
    mockListAndResolve([block])

    render(<TrashView />)

    // Open the destructive purge confirmation.
    const purgeBtn = await screen.findByRole('button', { name: /^Purge$/i })
    await user.click(purgeBtn)
    expect(screen.getByText('Permanently delete?')).toBeInTheDocument()

    // Cancel is auto-focused for destructive — reflex Enter dismisses.
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.queryByText('Permanently delete?')).not.toBeInTheDocument()
    })

    // purge_block MUST NOT have been called.
    expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'purge_block')).toHaveLength(0)
  })

  it('pressing Escape dismisses the purge confirmation', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'to purge', '2025-01-15T00:00:00Z')
    mockListAndResolve([block])

    render(<TrashView />)

    // First click: shows confirmation
    const purgeBtn = await screen.findByRole('button', { name: /^Purge$/i })
    await user.click(purgeBtn)

    expect(screen.getByText('Permanently delete?')).toBeInTheDocument()

    // Press Escape to dismiss
    await user.keyboard('{Escape}')

    expect(screen.queryByText('Permanently delete?')).not.toBeInTheDocument()
  })

  it('purge executes on confirmation Yes click', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'to purge', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_block') return { block_id: 'B1', purged_count: 1 }
      return undefined
    })

    render(<TrashView />)

    // First click shows confirmation
    const purgeBtn = await screen.findByRole('button', { name: /^Purge$/i })
    await user.click(purgeBtn)

    // Second click (Yes) executes purge
    const yesBtn = screen.getByRole('button', { name: /Yes/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('purge_block', { blockId: 'B1' })
    })
  })

  it('shows Load More button when has_more is true', async () => {
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')], true)

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
    let callCount = 0
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') {
        callCount++
        return callCount === 1 ? page1 : page2
      }
      if (cmd === 'batch_resolve') return []
      return undefined
    })

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
        agenda: null,
        cursor: 'cursor_page2',
        limit: 50,
        spaceId: 'SPACE_TEST',
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
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_block') return { block_id: 'B1', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)

    expect(await screen.findByText('to restore')).toBeInTheDocument()

    const restoreBtn = screen.getByTestId('trash-restore-btn')
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

    // Component catches the error, loading ends, blocks stays empty
    // so the empty state is shown
    expect(
      await screen.findByText(/Nothing in trash\. Deleted items will appear here\./),
    ).toBeInTheDocument()

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load trash')
    })
  })

  it('handles failed restore gracefully', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'item', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_block') throw new Error('Restore failed')
      return undefined
    })

    render(<TrashView />)

    const restoreBtn = await screen.findByTestId('trash-restore-btn')
    await user.click(restoreBtn)

    // Block should still be in the list (restore failed, so don't remove it)
    await waitFor(() => {
      expect(screen.getByText('item')).toBeInTheDocument()
    })

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to restore block')
    })
  })

  it('handles failed purge gracefully', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'item', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_block') throw new Error('Purge failed')
      return undefined
    })

    render(<TrashView />)

    // First click shows confirmation
    const purgeBtn = await screen.findByRole('button', { name: /^Purge$/i })
    await user.click(purgeBtn)

    // Second click (Yes) triggers purge which fails
    const yesBtn = screen.getByRole('button', { name: /Yes/i })
    await user.click(yesBtn)

    // Block should still be in the list (purge failed)
    await waitFor(() => {
      expect(screen.getByText('item')).toBeInTheDocument()
    })

    // Should show error toast
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to purge block')
    })
  })

  it('shows success toast after successful restore', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'to restore', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_block') return { block_id: 'B1', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)

    const restoreBtn = await screen.findByTestId('trash-restore-btn')
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Block restored')
    })
  })

  it('shows success toast after successful purge', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'to purge', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_block') return { block_id: 'B1', purged_count: 1 }
      return undefined
    })

    render(<TrashView />)

    const purgeBtn = await screen.findByRole('button', { name: /^Purge$/i })
    await user.click(purgeBtn)

    const yesBtn = screen.getByRole('button', { name: /Yes/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Block permanently deleted')
    })
  })

  // ── Resolve cache updates ───────────────────────────────────────────

  it('updates resolve cache when restoring a page block', async () => {
    const user = userEvent.setup()
    const block = {
      ...makeBlock('P1', 'My Page', '2025-01-15T12:00:00Z'),
      block_type: 'page',
    }
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_block') return { block_id: 'P1', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)

    const restoreBtn = await screen.findByTestId('trash-restore-btn')
    await user.click(restoreBtn)

    await waitFor(() => {
      const entry = useResolveStore.getState().cache.get(keyFor('SPACE_TEST', 'P1'))
      expect(entry).toEqual({ title: 'My Page', deleted: false })
    })
  })

  it('does not update resolve cache when restoring a content block', async () => {
    const user = userEvent.setup()
    const block = makeBlock('C1', 'content text', '2025-01-15T12:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_block') return { block_id: 'C1', restored_count: 1 }
      return undefined
    })

    const versionBefore = useResolveStore.getState().version

    render(<TrashView />)

    const restoreBtn = await screen.findByTestId('trash-restore-btn')
    await user.click(restoreBtn)

    // Wait for the block to be removed from the list (restore succeeded)
    await waitFor(() => {
      expect(screen.queryByText('content text')).not.toBeInTheDocument()
    })

    // Cache version should not have changed (no set() called for content blocks)
    expect(useResolveStore.getState().version).toBe(versionBefore)
  })

  // ── Multi-select ────────────────────────────────────────────────────

  it('renders checkboxes on each trash item', async () => {
    mockListAndResolve([
      makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z'),
    ])

    render(<TrashView />)

    await screen.findByText('item 1')
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    expect(checkboxes).toHaveLength(2)
    // All unchecked initially
    for (const cb of checkboxes) {
      expect(cb).not.toBeChecked()
    }
  })

  it('click on checkbox toggles selection', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('item 1')
    const checkbox = screen.getByTestId('trash-item-checkbox')

    // Click to select
    await user.click(checkbox)
    expect(checkbox).toBeChecked()

    // Click again to deselect
    await user.click(checkbox)
    expect(checkbox).not.toBeChecked()
  })

  it('clicking a row toggles selection', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    const item = await screen.findByTestId('trash-item')
    await user.click(item)

    const checkbox = screen.getByTestId('trash-item-checkbox')
    expect(checkbox).toBeChecked()
  })

  it('Shift+Click range-selects items', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z'),
      makeBlock('B3', 'item 3', '2025-01-13T00:00:00Z'),
    ])

    render(<TrashView />)

    await screen.findByText('item 1')
    const items = screen.getAllByTestId('trash-item')

    // Click first item
    await user.click(items[0] as HTMLElement)

    // Shift+click third item
    await user.keyboard('{Shift>}')
    await user.click(items[2] as HTMLElement)
    await user.keyboard('{/Shift}')

    // All three checkboxes should be checked
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    expect(checkboxes[0] as HTMLElement).toBeChecked()
    expect(checkboxes[1] as HTMLElement).toBeChecked()
    expect(checkboxes[2] as HTMLElement).toBeChecked()
  })

  it('selection toolbar appears with correct count', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z'),
    ])

    render(<TrashView />)

    await screen.findByText('item 1')

    // No toolbar initially
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()

    // Select one item
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    await user.click(checkboxes[0] as HTMLElement)

    // Toolbar should appear with "1 selected"
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar).toBeInTheDocument()
    expect(within(toolbar).getByText('1 selected')).toBeInTheDocument()

    // Select another
    await user.click(checkboxes[1] as HTMLElement)
    expect(within(toolbar).getByText('2 selected')).toBeInTheDocument()
  })

  it('selection toolbar has Select all, Deselect all, Restore selected, Purge selected buttons', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('item 1')
    const checkbox = screen.getByTestId('trash-item-checkbox')
    await user.click(checkbox)

    expect(screen.getByRole('button', { name: /^Select all$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Deselect all$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Restore selected$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Purge selected$/i })).toBeInTheDocument()
  })

  it('batch restore calls restoreBlock for each selected', async () => {
    const user = userEvent.setup()
    const blocks = [
      makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z'),
    ]
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_block') return { block_id: 'XX', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('item 1')

    // Select both items
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    // Click Restore selected
    const restoreSelectedBtn = screen.getByRole('button', { name: /Restore selected/i })
    await user.click(restoreSelectedBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restore_block', {
        blockId: 'B1',
        deletedAtRef: '2025-01-15T00:00:00Z',
      })
      expect(mockedInvoke).toHaveBeenCalledWith('restore_block', {
        blockId: 'B2',
        deletedAtRef: '2025-01-14T00:00:00Z',
      })
    })

    // Should show batch toast
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('2 blocks restored')
    })
  })

  it('batch purge shows confirmation dialog then calls purgeBlock for each', async () => {
    const user = userEvent.setup()
    const blocks = [
      makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z'),
    ]
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_block') return { block_id: 'XX', purged_count: 1 }
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('item 1')

    // Select both items
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    // Click Purge selected
    const purgeSelectedBtn = screen.getByRole('button', { name: /Purge selected/i })
    await user.click(purgeSelectedBtn)

    // Confirmation dialog should appear
    expect(screen.getByText(/Permanently delete 2 items\?/)).toBeInTheDocument()

    // Confirm
    const yesBtn = screen.getByRole('button', { name: /Yes/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('purge_block', { blockId: 'B1' })
      expect(mockedInvoke).toHaveBeenCalledWith('purge_block', { blockId: 'B2' })
    })

    // Should show batch toast
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('2 blocks permanently deleted')
    })
  })

  it('Deselect all clears selection and hides toolbar', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('item 1')
    const checkbox = screen.getByTestId('trash-item-checkbox')
    await user.click(checkbox)

    expect(screen.getByRole('toolbar')).toBeInTheDocument()

    const deselectBtn = screen.getByRole('button', { name: /Deselect all/i })
    await user.click(deselectBtn)

    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(checkbox).not.toBeChecked()
  })

  it('Select all selects all visible items', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z'),
    ])

    render(<TrashView />)

    await screen.findByText('item 1')

    // Select one to reveal toolbar
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    await user.click(checkboxes[0] as HTMLElement)

    // Click Select all
    const selectAllBtn = screen.getByRole('button', { name: /^Select all$/i })
    await user.click(selectAllBtn)

    // Both should be checked
    for (const cb of checkboxes) {
      expect(cb).toBeChecked()
    }
    expect(within(screen.getByRole('toolbar')).getByText('2 selected')).toBeInTheDocument()
  })

  // ── Original location breadcrumbs ───────────────────────────────────

  it('renders breadcrumbs with parent page title', async () => {
    const blocks = [makeBlock('B1', 'child block', '2025-01-15T00:00:00Z', 'P1')]
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve')
        return [{ id: 'P1', title: 'My Parent Page', block_type: 'page', deleted: false }]
      return undefined
    })

    render(<TrashView />)

    // Wait for breadcrumb to appear
    const breadcrumb = await screen.findByTestId('trash-item-breadcrumb')
    expect(breadcrumb).toHaveTextContent('from: My Parent Page')
  })

  it('shows "(deleted page)" when parent is deleted', async () => {
    const blocks = [makeBlock('B1', 'orphan block', '2025-01-15T00:00:00Z', 'P_DELETED')]
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve')
        return [{ id: 'P_DELETED', title: 'Old Page', block_type: 'page', deleted: true }]
      return undefined
    })

    render(<TrashView />)

    const breadcrumb = await screen.findByTestId('trash-item-breadcrumb')
    expect(breadcrumb).toHaveTextContent('from: (deleted page)')
  })

  it('shows "(deleted page)" when parent is not found in batch resolve', async () => {
    const blocks = [makeBlock('B1', 'orphan block', '2025-01-15T00:00:00Z', 'P_MISSING')]
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return [] // parent not found
      return undefined
    })

    render(<TrashView />)

    const breadcrumb = await screen.findByTestId('trash-item-breadcrumb')
    expect(breadcrumb).toHaveTextContent('from: (deleted page)')
  })

  it('does not render breadcrumb when block has no parent_id', async () => {
    mockListAndResolve([makeBlock('B1', 'root block', '2025-01-15T00:00:00Z', null)])

    render(<TrashView />)

    await screen.findByText('root block')
    expect(screen.queryByTestId('trash-item-breadcrumb')).not.toBeInTheDocument()
  })

  // ── a11y ────────────────────────────────────────────────────────────

  it('trash items use responsive stacking for mobile', async () => {
    mockListAndResolve([makeBlock('B1', 'responsive item', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    const trashItem = await screen.findByTestId('trash-item')
    expect(trashItem.className).toContain('flex-col')
    expect(trashItem.className).toContain('sm:flex-row')
  })

  it('has no a11y violations', async () => {
    mockListAndResolve([makeBlock('B1', 'accessible item', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('accessible item')

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with selection toolbar visible', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'accessible item', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('accessible item')

    // Select an item to show toolbar
    const checkbox = screen.getByTestId('trash-item-checkbox')
    await user.click(checkbox)

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  // ── Filter / search ─────────────────────────────────────────────────

  it('renders filter input when items exist', async () => {
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('item 1')
    expect(screen.getByTestId('trash-filter-input')).toBeInTheDocument()
  })

  it('does not render filter input when trash is empty', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<TrashView />)

    await screen.findByText(/Nothing in trash/)
    expect(screen.queryByTestId('trash-filter-input')).not.toBeInTheDocument()
  })

  it('typing filters items by content match', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'apple pie', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'banana split', '2025-01-14T00:00:00Z'),
      makeBlock('B3', 'cherry tart', '2025-01-13T00:00:00Z'),
    ])

    render(<TrashView />)

    await screen.findByText('apple pie')
    const input = screen.getByTestId('trash-filter-input')
    await user.type(input, 'apple')

    await waitFor(() => {
      expect(screen.getByText('apple pie')).toBeInTheDocument()
      expect(screen.queryByText('banana split')).not.toBeInTheDocument()
      expect(screen.queryByText('cherry tart')).not.toBeInTheDocument()
    })
  })

  it('empty filter shows all items', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'apple pie', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'banana split', '2025-01-14T00:00:00Z'),
    ])

    render(<TrashView />)

    await screen.findByText('apple pie')
    const input = screen.getByTestId('trash-filter-input')

    // Type then clear
    await user.type(input, 'apple')
    await waitFor(() => {
      expect(screen.queryByText('banana split')).not.toBeInTheDocument()
    })

    await user.clear(input)
    await waitFor(() => {
      expect(screen.getByText('apple pie')).toBeInTheDocument()
      expect(screen.getByText('banana split')).toBeInTheDocument()
    })
  })

  it('no-match shows empty state with clear button', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'apple pie', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('apple pie')
    const input = screen.getByTestId('trash-filter-input')
    await user.type(input, 'xyz')

    await waitFor(() => {
      expect(screen.getByText('No matching deleted items')).toBeInTheDocument()
    })
    expect(screen.getByTestId('trash-clear-filter-btn')).toBeInTheDocument()
  })

  it('clear button resets filter', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'apple pie', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('apple pie')
    const input = screen.getByTestId('trash-filter-input')
    await user.type(input, 'xyz')

    await waitFor(() => {
      expect(screen.getByText('No matching deleted items')).toBeInTheDocument()
    })

    const clearBtn = screen.getByTestId('trash-clear-filter-btn')
    await user.click(clearBtn)

    await waitFor(() => {
      expect(screen.getByText('apple pie')).toBeInTheDocument()
    })
    expect(input).toHaveValue('')
  })

  // UX-246: SearchInput clear (✕) button on the filter input itself
  // (distinct from the empty-state `trash-clear-filter-btn`).
  it('SearchInput clear (✕) button resets filter and list', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'apple pie', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'banana split', '2025-01-14T00:00:00Z'),
    ])

    const { container } = render(<TrashView />)

    await screen.findByText('apple pie')
    const input = screen.getByTestId('trash-filter-input') as HTMLInputElement

    // No clear button while empty
    expect(container.querySelector('[data-testid="search-input-clear"]')).toBeNull()

    await user.type(input, 'apple')

    await waitFor(() => {
      expect(screen.queryByText('banana split')).not.toBeInTheDocument()
    })

    const clearButton = container.querySelector(
      '[data-testid="search-input-clear"]',
    ) as HTMLButtonElement | null
    expect(clearButton).not.toBeNull()

    // a11y on the filtered state including the visible clear button.
    const axeResults = await axe(container)
    expect(axeResults).toHaveNoViolations()

    await user.click(clearButton as HTMLButtonElement)

    // Filter is cleared: both items visible, input empty, ✕ button gone
    await waitFor(() => {
      expect(input.value).toBe('')
      expect(screen.getByText('apple pie')).toBeInTheDocument()
      expect(screen.getByText('banana split')).toBeInTheDocument()
      expect(container.querySelector('[data-testid="search-input-clear"]')).toBeNull()
    })
  })

  it('filtered count shows correctly', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'apple pie', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'apple tart', '2025-01-14T00:00:00Z'),
      makeBlock('B3', 'banana split', '2025-01-13T00:00:00Z'),
    ])

    render(<TrashView />)

    await screen.findByText('apple pie')
    const input = screen.getByTestId('trash-filter-input')
    await user.type(input, 'apple')

    await waitFor(() => {
      const count = screen.getByTestId('trash-filter-count')
      expect(count).toHaveTextContent('Showing 2 of 3 deleted items')
    })
  })

  it('filter is case-insensitive', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'Apple Pie', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'banana split', '2025-01-14T00:00:00Z'),
    ])

    render(<TrashView />)

    await screen.findByText('Apple Pie')
    const input = screen.getByTestId('trash-filter-input')
    await user.type(input, 'apple')

    await waitFor(() => {
      expect(screen.getByText('Apple Pie')).toBeInTheDocument()
      expect(screen.queryByText('banana split')).not.toBeInTheDocument()
    })
  })

  it('has no a11y violations with filter input', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'apple pie', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'banana split', '2025-01-14T00:00:00Z'),
    ])

    render(<TrashView />)

    await screen.findByText('apple pie')
    const input = screen.getByTestId('trash-filter-input')
    await user.type(input, 'apple')

    await waitFor(async () => {
      const results = await axe(document.body)
      expect(results).toHaveNoViolations()
    })
  })

  // UX-248 — Unicode-aware fold: trash filter matches Turkish / German
  // / accented content via `matchesSearchFolded`.
  it('filter matches Turkish İstanbul when query is lowercase istanbul', async () => {
    const user = userEvent.setup()
    mockListAndResolve([
      makeBlock('B1', 'İstanbul trip notes', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'Ankara notes', '2025-01-14T00:00:00Z'),
    ])

    render(<TrashView />)
    await screen.findByText('İstanbul trip notes')

    const input = screen.getByTestId('trash-filter-input')
    await user.type(input, 'istanbul')

    await waitFor(() => {
      expect(screen.getByText('İstanbul trip notes')).toBeInTheDocument()
      expect(screen.queryByText('Ankara notes')).not.toBeInTheDocument()
    })
  })

  // ── Empty Trash / Restore All header buttons ───────────────────────

  it('renders Empty Trash and Restore All header buttons when items exist', async () => {
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('item 1')
    expect(screen.getByTestId('trash-empty-trash-btn')).toBeInTheDocument()
    expect(screen.getByTestId('trash-restore-all-btn')).toBeInTheDocument()
  })

  it('does not render Empty Trash and Restore All header buttons when trash is empty', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<TrashView />)

    await screen.findByText(/Nothing in trash/)
    expect(screen.queryByTestId('trash-empty-trash-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('trash-restore-all-btn')).not.toBeInTheDocument()
  })

  it('opens confirmation dialog when Empty Trash is clicked', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('item 1')
    const emptyTrashBtn = screen.getByTestId('trash-empty-trash-btn')
    await user.click(emptyTrashBtn)

    expect(screen.getByText('Empty trash?')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This will permanently delete all items in the trash. This cannot be undone.',
      ),
    ).toBeInTheDocument()
  })

  it('calls purgeAllDeleted on Empty Trash confirmation', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks')
        return {
          items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_all_deleted') return { affected_count: 5 }
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('item 1')
    const emptyTrashBtn = screen.getByTestId('trash-empty-trash-btn')
    await user.click(emptyTrashBtn)

    // Confirm the dialog
    const yesBtn = screen.getByRole('button', { name: /Yes/i })
    await user.click(yesBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('purge_all_deleted')
    })
  })

  it('shows success toast with count after empty trash', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks')
        return {
          items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_all_deleted') return { affected_count: 5 }
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('item 1')
    await user.click(screen.getByTestId('trash-empty-trash-btn'))
    await user.click(screen.getByRole('button', { name: /Yes/i }))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Trash emptied (5 items permanently deleted)')
    })
  })

  it('shows error toast on empty trash failure', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks')
        return {
          items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_all_deleted') throw new Error('DB error')
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('item 1')
    await user.click(screen.getByTestId('trash-empty-trash-btn'))
    await user.click(screen.getByRole('button', { name: /Yes/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to empty trash')
    })
  })

  it('opens confirmation dialog when Restore All header is clicked', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('item 1')
    const restoreAllBtn = screen.getByTestId('trash-restore-all-btn')
    await user.click(restoreAllBtn)

    expect(screen.getByText('Restore all items?')).toBeInTheDocument()
    expect(
      screen.getByText('This will restore all items from the trash to their original locations.'),
    ).toBeInTheDocument()
  })

  it('calls restoreAllDeleted on Restore All confirmation', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks')
        return {
          items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_all_deleted') return { affected_count: 3 }
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('item 1')
    const restoreAllBtn = screen.getByTestId('trash-restore-all-btn')
    await user.click(restoreAllBtn)

    // Confirm the dialog
    const dialog = screen.getByRole('alertdialog')
    const restoreBtn = within(dialog).getByRole('button', { name: /^Restore$/i })
    await user.click(restoreBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restore_all_deleted')
    })
  })

  it('shows success toast with count after restore all', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks')
        return {
          items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_all_deleted') return { affected_count: 3 }
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('item 1')
    await user.click(screen.getByTestId('trash-restore-all-btn'))
    const dialog = screen.getByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /^Restore$/i }))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('3 items restored')
    })
  })

  it('shows error toast on restore all failure', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks')
        return {
          items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_all_deleted') throw new Error('DB error')
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('item 1')
    await user.click(screen.getByTestId('trash-restore-all-btn'))
    const dialog = screen.getByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: /^Restore$/i }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to restore all items')
    })
  })

  it('relabeled batch buttons say Restore Selected / Purge Selected', async () => {
    const user = userEvent.setup()
    mockListAndResolve([makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')])

    render(<TrashView />)

    await screen.findByText('item 1')

    // Select an item to show the toolbar
    const checkbox = screen.getByTestId('trash-item-checkbox')
    await user.click(checkbox)

    const toolbar = screen.getByRole('toolbar')
    expect(within(toolbar).getByRole('button', { name: /^Restore selected$/i })).toBeInTheDocument()
    expect(within(toolbar).getByRole('button', { name: /^Purge selected$/i })).toBeInTheDocument()
  })

  // ── UX-243: descendant-count badge ──────────────────────────────

  it('fetches descendant counts for every visible trash root', async () => {
    const block1 = makeBlock('R1', 'root with kids', '2025-01-15T00:00:00Z')
    const block2 = makeBlock('R2', 'lonely root', '2025-01-14T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_blocks')
        return { items: [block1, block2], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') {
        expect(args).toEqual({ rootIds: ['R1', 'R2'] })
        return { R1: 3 }
      }
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('root with kids')
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('trash_descendant_counts', {
        rootIds: ['R1', 'R2'],
      })
    })
  })

  it('renders +N blocks badge only on roots with cascade-deleted descendants', async () => {
    const blockWithKids = makeBlock('R1', 'root with kids', '2025-01-15T00:00:00Z')
    const lonelyBlock = makeBlock('R2', 'lonely root', '2025-01-14T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks')
        return {
          items: [blockWithKids, lonelyBlock],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return { R1: 3 }
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('root with kids')

    // Exactly one badge rendered — for R1 (count 3), not R2 (not in map).
    const badges = await screen.findAllByTestId('trash-descendant-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent('+3 blocks')
  })

  it('renders singular "+1 block" for roots with exactly one descendant', async () => {
    const single = makeBlock('R1', 'root + 1', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [single], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return { R1: 1 }
      return undefined
    })

    render(<TrashView />)

    const badge = await screen.findByTestId('trash-descendant-badge')
    expect(badge).toHaveTextContent('+1 block')
  })

  it('renders no batch-count badge when counts returns empty map', async () => {
    const block = makeBlock('R1', 'root', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return {}
      return undefined
    })

    render(<TrashView />)

    await screen.findByText('root')
    expect(screen.queryByTestId('trash-descendant-badge')).not.toBeInTheDocument()
  })

  it('per-row restore fires with the root id when badge is visible', async () => {
    const user = userEvent.setup()
    const block = makeBlock('R1', 'root with kids', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return { R1: 5 }
      if (cmd === 'restore_block') return { block_id: 'R1', restored_count: 6 }
      return undefined
    })

    render(<TrashView />)

    // Badge is rendered; action target is still the root id.
    await screen.findByTestId('trash-descendant-badge')
    await user.click(screen.getByTestId('trash-restore-btn'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('restore_block', {
        blockId: 'R1',
        deletedAtRef: '2025-01-15T00:00:00Z',
      })
    })
  })

  it('logs warning and keeps list usable when count fetch fails', async () => {
    const block = makeBlock('R1', 'root', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') throw new Error('DB unavailable')
      return undefined
    })

    render(<TrashView />)

    // List still renders, no badge.
    await screen.findByText('root')
    expect(screen.queryByTestId('trash-descendant-badge')).not.toBeInTheDocument()
  })
})

describe('TrashView screen reader announcements (UX-282)', () => {
  it('announces batch restore count after Restore selected', async () => {
    const { announce } = await import('../../lib/announcer')
    const mockedAnnounce = vi.mocked(announce)
    const user = userEvent.setup()
    const blocks = [
      makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z'),
    ]
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'restore_block') return { block_id: 'XX', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 1')
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)
    await user.click(screen.getByRole('button', { name: /Restore selected/i }))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('2 blocks restored from trash')
    })
  })

  it('announces batch purge count after confirmation', async () => {
    const { announce } = await import('../../lib/announcer')
    const mockedAnnounce = vi.mocked(announce)
    const user = userEvent.setup()
    const blocks = [
      makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z'),
    ]
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_block') return { block_id: 'XX', purged_count: 1 }
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 1')
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)
    await user.click(screen.getByRole('button', { name: /Purge selected/i }))
    await user.click(screen.getByRole('button', { name: /Yes/i }))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('2 blocks permanently deleted')
    })
  })

  it('announces trash emptied count on Empty Trash success', async () => {
    const { announce } = await import('../../lib/announcer')
    const mockedAnnounce = vi.mocked(announce)
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks')
        return {
          items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_all_deleted') return { affected_count: 5 }
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 1')
    await user.click(screen.getByTestId('trash-empty-trash-btn'))
    await user.click(screen.getByRole('button', { name: /Yes/i }))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Trash emptied — 5 items permanently deleted')
    })
  })

  it('announces failure when empty trash backend rejects', async () => {
    const { announce } = await import('../../lib/announcer')
    const mockedAnnounce = vi.mocked(announce)
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, _args?: unknown) => {
      if (cmd === 'list_blocks')
        return {
          items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
          next_cursor: null,
          has_more: false,
        }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'purge_all_deleted') throw new Error('DB error')
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 1')
    await user.click(screen.getByTestId('trash-empty-trash-btn'))
    await user.click(screen.getByRole('button', { name: /Yes/i }))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Empty trash failed')
    })
  })
})

// =========================================================================
// UX-275 sub-fix 2/3/8: descendant badge stability, batch toolbar
// keyboard shortcuts, and large-batch restore confirmation.
// =========================================================================

describe('TrashView UX-275 batch toolbar interaction', () => {
  // -- sub-fix 2: badge testid + nowrap utility ----------------------------
  it('descendant badge carries the stable testid and whitespace-nowrap', async () => {
    const block = makeBlock('R1', 'root with kids', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return { R1: 4 }
      return undefined
    })

    render(<TrashView />)

    const badge = await screen.findByTestId('trash-descendant-badge')
    expect(badge).toHaveTextContent('+4 blocks')
    // The defensive whitespace-nowrap utility is on the badge regardless of
    // any future Badge variant changes.
    expect(badge.className).toContain('whitespace-nowrap')
  })

  // -- sub-fix 3: keyboard shortcuts ---------------------------------------
  it('Shift+R triggers batch restore (gated by the >5 confirm)', async () => {
    const user = userEvent.setup()
    const blocks = [
      makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z'),
      makeBlock('B2', 'item 2', '2025-01-14T00:00:00Z'),
    ]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return {}
      if (cmd === 'restore_block') return { block_id: 'XX', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 1')

    // Select both items via the row checkboxes.
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(checkboxes[1] as HTMLElement)

    // The keydown handler ignores events while focus is in an INPUT — move
    // focus to the document body to mimic the user releasing the checkbox.
    ;(document.activeElement as HTMLElement)?.blur()

    // Selection ≤ 5 → Shift+R restores immediately, no confirmation dialog.
    await user.keyboard('{Shift>}R{/Shift}')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'restore_block',
        expect.objectContaining({ blockId: 'B1' }),
      )
      expect(mockedInvoke).toHaveBeenCalledWith(
        'restore_block',
        expect.objectContaining({ blockId: 'B2' }),
      )
    })
  })

  it('Shift+Delete opens the batch purge confirmation dialog', async () => {
    const user = userEvent.setup()
    const blocks = [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return {}
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 1')

    await user.click(screen.getByTestId('trash-item-checkbox'))
    ;(document.activeElement as HTMLElement)?.blur()

    // Trigger the shortcut.
    await user.keyboard('{Shift>}{Delete}{/Shift}')

    // Batch purge confirmation should be visible.
    expect(await screen.findByText(/Permanently delete 1 items?/i)).toBeInTheDocument()
  })

  it('toolbar shortcuts do nothing when nothing is selected', async () => {
    const user = userEvent.setup()
    const blocks = [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')]
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return {}
      if (cmd === 'restore_block') return { block_id: 'XX', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 1')

    await user.keyboard('{Shift>}R{/Shift}')
    await user.keyboard('{Shift>}{Delete}{/Shift}')

    // Neither shortcut should have produced a side-effect: no restore_block,
    // no batch purge confirmation dialog mounted.
    expect(mockedInvoke).not.toHaveBeenCalledWith('restore_block', expect.anything())
    expect(screen.queryByText(/Permanently delete \d+ items\?/i)).not.toBeInTheDocument()
  })

  it('aria-keyshortcuts are advertised on the batch action buttons', async () => {
    const user = userEvent.setup()
    const block = makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: [block], next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return {}
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 1')

    await user.click(screen.getByTestId('trash-item-checkbox'))

    expect(screen.getByTestId('trash-batch-restore-btn')).toHaveAttribute(
      'aria-keyshortcuts',
      'Shift+R',
    )
    expect(screen.getByTestId('trash-batch-purge-btn')).toHaveAttribute(
      'aria-keyshortcuts',
      'Shift+Delete',
    )
  })

  // -- sub-fix 8: large-batch restore confirmation -------------------------
  it('large batch restore (>5) opens a confirmation dialog before restoring', async () => {
    const user = userEvent.setup()
    const blocks = Array.from({ length: 6 }, (_, i) =>
      makeBlock(`B${i}`, `item ${i}`, '2025-01-15T00:00:00Z'),
    )
    let restoreCalls = 0
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return {}
      if (cmd === 'restore_block') {
        restoreCalls++
        return { block_id: 'XX', restored_count: 1 }
      }
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 0')

    // Click the first checkbox to mount the batch toolbar (Select all lives there).
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(screen.getByRole('button', { name: /^Select all$/i }))

    // Click Restore — this should open the confirmation dialog, NOT restore yet.
    await user.click(screen.getByTestId('trash-batch-restore-btn'))

    // Dialog open, no restore call yet.
    expect(await screen.findByTestId('trash-batch-restore-confirm')).toBeInTheDocument()
    expect(restoreCalls).toBe(0)

    // Confirm — now the actual batch restore fires.
    await user.click(screen.getByTestId('trash-batch-restore-yes'))

    await waitFor(() => {
      expect(restoreCalls).toBe(6)
    })
  })

  it('small batch restore (<=5) skips the confirmation dialog', async () => {
    const user = userEvent.setup()
    const blocks = Array.from({ length: 3 }, (_, i) =>
      makeBlock(`B${i}`, `item ${i}`, '2025-01-15T00:00:00Z'),
    )
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return {}
      if (cmd === 'restore_block') return { block_id: 'XX', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 0')

    // Select all 3 items.
    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    for (const cb of checkboxes) {
      await user.click(cb as HTMLElement)
    }

    // Click Restore — should fire immediately (no confirmation dialog).
    await user.click(screen.getByTestId('trash-batch-restore-btn'))

    expect(screen.queryByTestId('trash-batch-restore-confirm')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'restore_block',
        expect.objectContaining({ blockId: 'B0' }),
      )
    })
  })

  it('cancelling the large-batch restore dialog leaves selection untouched', async () => {
    const user = userEvent.setup()
    const blocks = Array.from({ length: 6 }, (_, i) =>
      makeBlock(`B${i}`, `item ${i}`, '2025-01-15T00:00:00Z'),
    )
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return { items: blocks, next_cursor: null, has_more: false }
      if (cmd === 'batch_resolve') return []
      if (cmd === 'trash_descendant_counts') return {}
      if (cmd === 'restore_block') return { block_id: 'XX', restored_count: 1 }
      return undefined
    })

    render(<TrashView />)
    await screen.findByText('item 0')

    const checkboxes = screen.getAllByTestId('trash-item-checkbox')
    await user.click(checkboxes[0] as HTMLElement)
    await user.click(screen.getByRole('button', { name: /^Select all$/i }))

    await user.click(screen.getByTestId('trash-batch-restore-btn'))
    expect(await screen.findByTestId('trash-batch-restore-confirm')).toBeInTheDocument()

    // Cancel.
    await user.click(screen.getByTestId('trash-batch-restore-no'))

    await waitFor(() => {
      expect(screen.queryByTestId('trash-batch-restore-confirm')).not.toBeInTheDocument()
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('restore_block', expect.anything())
  })
})
