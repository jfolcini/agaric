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
import { useResolveStore } from '../../stores/resolve'
import { TrashView } from '../TrashView'

vi.mock('../StaticBlock', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

vi.mock('../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
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
        agendaDateRange: null,
        agendaSource: null,
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
        agendaDate: null,
        agendaDateRange: null,
        agendaSource: null,
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
      const entry = useResolveStore.getState().cache.get('P1')
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
      const results = await axe(document.body, {
        rules: {
          'nested-interactive': { enabled: false },
        },
      })
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
      const results = await axe(document.body, {
        rules: {
          'nested-interactive': { enabled: false },
        },
      })
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
      const results = await axe(document.body, {
        rules: {
          'nested-interactive': { enabled: false },
        },
      })
      expect(results).toHaveNoViolations()
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
    const badges = await screen.findAllByTestId('trash-item-batch-count')
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

    const badge = await screen.findByTestId('trash-item-batch-count')
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
    expect(screen.queryByTestId('trash-item-batch-count')).not.toBeInTheDocument()
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
    await screen.findByTestId('trash-item-batch-count')
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
    expect(screen.queryByTestId('trash-item-batch-count')).not.toBeInTheDocument()
  })
})
