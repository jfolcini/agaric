/**
 * Tests for PageBrowser component.
 *
 * Validates:
 *  - Initial load calls listBlocks with blockType='page'
 *  - Cursor-based pagination (Load More button)
 *  - Empty state and loading states
 *  - Page selection callback
 */

import { invoke } from '@tauri-apps/api/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageBrowser } from '../PageBrowser'

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

describe('PageBrowser', () => {
  it('calls listBlocks with blockType=page on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await act(async () => {
      root.render(createElement(PageBrowser))
    })

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

  it('renders pages when data is returned', async () => {
    const page = {
      items: [makePage('P1', 'First page'), makePage('P2', 'Second page')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    await act(async () => {
      root.render(createElement(PageBrowser))
    })

    const items = container.querySelectorAll('.page-browser-item')
    expect(items.length).toBe(2)
    expect(items[0].textContent).toBe('First page')
    expect(items[1].textContent).toBe('Second page')
  })

  it('renders empty state when no pages exist', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    await act(async () => {
      root.render(createElement(PageBrowser))
    })

    expect(container.querySelector('.page-browser-empty')?.textContent).toContain('No pages yet')
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

    await act(async () => {
      root.render(createElement(PageBrowser))
    })

    const item = container.querySelector('.page-browser-item-title')
    expect(item?.textContent).toBe('Untitled')
  })

  it('uses cursor-based pagination with Load More', async () => {
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

    await act(async () => {
      root.render(createElement(PageBrowser))
    })

    // Load More button should be visible
    const loadMoreBtn = container.querySelector('.page-browser-load-more') as HTMLButtonElement
    expect(loadMoreBtn).toBeTruthy()

    await act(async () => {
      loadMoreBtn.click()
    })

    // Should call with the cursor from page 1
    expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
      parentId: null,
      blockType: 'page',
      tagId: null,
      showDeleted: null,
      agendaDate: null,
      cursor: 'cursor_abc',
      limit: 50,
    })

    // Both pages should be rendered (accumulated)
    expect(container.querySelectorAll('.page-browser-item').length).toBe(2)

    // Load More should disappear after last page
    expect(container.querySelector('.page-browser-load-more')).toBeNull()
  })

  it('fires onPageSelect callback when a page is clicked', async () => {
    const onPageSelect = vi.fn()
    const page = {
      items: [makePage('P1', 'Click me')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    await act(async () => {
      root.render(createElement(PageBrowser, { onPageSelect }))
    })

    const item = container.querySelector('.page-browser-item') as HTMLButtonElement
    await act(async () => {
      item.click()
    })

    expect(onPageSelect).toHaveBeenCalledWith('P1')
  })
})
