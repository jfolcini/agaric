/**
 * Tests for TrashView component.
 *
 * Uses React's createRoot + jsdom (no @testing-library/react needed).
 * Validates:
 *  - Initial load calls listBlocks({ showDeleted: true })
 *  - Renders block items with restore/purge controls
 *  - Restore passes deleted_at_ref to restoreBlock
 *  - Purge requires explicit confirmation (two-click)
 *  - Cursor-based pagination (load more)
 *  - Empty state rendering
 */

import { invoke } from '@tauri-apps/api/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrashView } from '../TrashView'

const mockedInvoke = vi.mocked(invoke)

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

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

describe('TrashView', () => {
  it('calls listBlocks with showDeleted:true on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await act(async () => {
      root.render(createElement(TrashView))
    })

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

  it('renders empty state when no deleted blocks', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await act(async () => {
      root.render(createElement(TrashView))
    })

    expect(container.querySelector('.trash-view-empty')?.textContent).toBe('Trash is empty.')
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

    await act(async () => {
      root.render(createElement(TrashView))
    })

    const items = container.querySelectorAll('.trash-item')
    expect(items.length).toBe(2)

    // Each item should have a restore button
    const restoreBtns = container.querySelectorAll('.trash-restore-btn')
    expect(restoreBtns.length).toBe(2)

    // Each item should have a purge button (not in confirmation state yet)
    const purgeBtns = container.querySelectorAll('.trash-purge-btn')
    expect(purgeBtns.length).toBe(2)
  })

  it('restore calls restoreBlock with correct deleted_at_ref', async () => {
    const block = makeBlock('B1', 'item', '2025-01-15T12:00:00Z')
    mockedInvoke
      .mockResolvedValueOnce({ items: [block], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({ block_id: 'B1', restored_count: 1 })

    await act(async () => {
      root.render(createElement(TrashView))
    })

    const restoreBtn = container.querySelector('.trash-restore-btn') as HTMLButtonElement
    expect(restoreBtn).toBeTruthy()

    await act(async () => {
      restoreBtn.click()
    })

    // The second invoke call should be restore_block with the deleted_at_ref
    expect(mockedInvoke).toHaveBeenCalledWith('restore_block', {
      blockId: 'B1',
      deletedAtRef: '2025-01-15T12:00:00Z',
    })
  })

  it('purge requires two-click confirmation', async () => {
    const block = makeBlock('B1', 'to purge', '2025-01-15T00:00:00Z')
    mockedInvoke.mockResolvedValueOnce({
      items: [block],
      next_cursor: null,
      has_more: false,
    })

    await act(async () => {
      root.render(createElement(TrashView))
    })

    // First click: should show confirmation, NOT call purge_block
    const purgeBtn = container.querySelector('.trash-purge-btn') as HTMLButtonElement
    expect(purgeBtn).toBeTruthy()

    await act(async () => {
      purgeBtn.click()
    })

    // After first click, confirmation should appear
    const confirmText = container.querySelector('.trash-purge-confirm')
    expect(confirmText).toBeTruthy()
    expect(confirmText?.textContent).toContain('Delete forever?')

    // invoke should NOT have been called for purge yet (only the initial list_blocks)
    expect(mockedInvoke).toHaveBeenCalledTimes(1)

    // Clicking "No" should cancel
    const noBtn = container.querySelector('.trash-purge-no') as HTMLButtonElement
    await act(async () => {
      noBtn.click()
    })
    expect(container.querySelector('.trash-purge-confirm')).toBeNull()
    expect(mockedInvoke).toHaveBeenCalledTimes(1) // Still only the initial list call
  })

  it('purge executes on confirmation Yes click', async () => {
    const block = makeBlock('B1', 'to purge', '2025-01-15T00:00:00Z')
    mockedInvoke
      .mockResolvedValueOnce({ items: [block], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({ block_id: 'B1', purged_count: 1 })

    await act(async () => {
      root.render(createElement(TrashView))
    })

    // First click shows confirmation
    const purgeBtn = container.querySelector('.trash-purge-btn') as HTMLButtonElement
    await act(async () => {
      purgeBtn.click()
    })

    // Second click (Yes) executes purge
    const yesBtn = container.querySelector('.trash-purge-yes') as HTMLButtonElement
    await act(async () => {
      yesBtn.click()
    })

    expect(mockedInvoke).toHaveBeenCalledWith('purge_block', { blockId: 'B1' })
  })

  it('shows Load More button when has_more is true', async () => {
    const page1 = {
      items: [makeBlock('B1', 'item 1', '2025-01-15T00:00:00Z')],
      next_cursor: 'cursor_page2',
      has_more: true,
    }
    mockedInvoke.mockResolvedValueOnce(page1)

    await act(async () => {
      root.render(createElement(TrashView))
    })

    const loadMoreBtn = container.querySelector('.trash-load-more') as HTMLButtonElement
    expect(loadMoreBtn).toBeTruthy()
    expect(loadMoreBtn.textContent).toBe('Load more')
  })

  it('loads next page with cursor when Load More is clicked', async () => {
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

    await act(async () => {
      root.render(createElement(TrashView))
    })

    const loadMoreBtn = container.querySelector('.trash-load-more') as HTMLButtonElement
    await act(async () => {
      loadMoreBtn.click()
    })

    // Second call should use the cursor from page 1
    expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
      parentId: null,
      blockType: null,
      tagId: null,
      showDeleted: true,
      agendaDate: null,
      cursor: 'cursor_page2',
      limit: 50,
    })

    // Both items should now be rendered
    const items = container.querySelectorAll('.trash-item')
    expect(items.length).toBe(2)
  })

  it('hides Load More button when no more pages', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await act(async () => {
      root.render(createElement(TrashView))
    })

    expect(container.querySelector('.trash-load-more')).toBeNull()
  })

  it('removes block from list after successful restore', async () => {
    const block = makeBlock('B1', 'to restore', '2025-01-15T00:00:00Z')
    mockedInvoke
      .mockResolvedValueOnce({ items: [block], next_cursor: null, has_more: false })
      .mockResolvedValueOnce({ block_id: 'B1', restored_count: 1 })

    await act(async () => {
      root.render(createElement(TrashView))
    })

    expect(container.querySelectorAll('.trash-item').length).toBe(1)

    const restoreBtn = container.querySelector('.trash-restore-btn') as HTMLButtonElement
    await act(async () => {
      restoreBtn.click()
    })

    // Block should be removed from the list
    expect(container.querySelectorAll('.trash-item').length).toBe(0)
  })
})
