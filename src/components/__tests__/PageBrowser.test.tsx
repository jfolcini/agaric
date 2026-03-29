/**
 * Tests for PageBrowser component.
 *
 * Validates:
 *  - Initial load calls listBlocks with blockType='page'
 *  - Cursor-based pagination (Load More button)
 *  - Empty state and loading states
 *  - Page selection callback
 *  - Page deletion with confirmation dialog
 *  - Error feedback via toast on failed operations
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { PageBrowser } from '../PageBrowser'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

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

/** Find the trash (delete) button within a page row via its aria-label. */
function findTrashButton(row: HTMLElement): HTMLButtonElement {
  return within(row).getByRole('button', { name: /delete page/i })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PageBrowser', () => {
  it('calls listBlocks with blockType=page on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<PageBrowser />)

    await waitFor(() => {
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
  })

  it('renders pages when data is returned', async () => {
    const page = {
      items: [makePage('P1', 'First page'), makePage('P2', 'Second page')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<PageBrowser />)

    expect(await screen.findByText('First page')).toBeInTheDocument()
    expect(screen.getByText('Second page')).toBeInTheDocument()
  })

  it('renders empty state when no pages exist', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<PageBrowser />)

    expect(await screen.findByText(/No pages yet/)).toBeInTheDocument()
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

    render(<PageBrowser />)

    expect(await screen.findByText('Untitled')).toBeInTheDocument()
  })

  it('uses cursor-based pagination with Load More', async () => {
    const user = userEvent.setup()
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

    render(<PageBrowser />)

    // Load More button should be visible after initial load
    const loadMoreBtn = await screen.findByRole('button', { name: /Load more/i })
    expect(loadMoreBtn).toBeInTheDocument()

    await user.click(loadMoreBtn)

    // Should call with the cursor from page 1
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
        parentId: null,
        blockType: 'page',
        tagId: null,
        showDeleted: null,
        agendaDate: null,
        cursor: 'cursor_abc',
        limit: 50,
      })
    })

    // Both pages should be rendered (accumulated)
    expect(await screen.findByText('Page 1')).toBeInTheDocument()
    expect(screen.getByText('Page 2')).toBeInTheDocument()

    // Load More should disappear after last page
    expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument()
  })

  it('fires onPageSelect callback when a page is clicked', async () => {
    const user = userEvent.setup()
    const onPageSelect = vi.fn()
    const page = {
      items: [makePage('P1', 'Click me')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<PageBrowser onPageSelect={onPageSelect} />)

    const pageTitle = await screen.findByText('Click me')
    await user.click(pageTitle)

    expect(onPageSelect).toHaveBeenCalledWith('P1', 'Click me')
  })

  // UX #2: Page delete from PageBrowser
  describe('page deletion', () => {
    it('shows trash icon on page item hover area', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage('P1', 'My Page')],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('My Page')

      // The page row should have a group class with both a select button and a trash button
      const pageRow = screen.getByText('My Page').closest('.group') as HTMLElement
      expect(pageRow).toBeTruthy()
      // There should be at least 2 buttons: page select and trash
      const allButtons = pageRow.querySelectorAll('button')
      expect(allButtons.length).toBeGreaterThanOrEqual(2)
      // The trash button has an aria-label
      const trashBtn = findTrashButton(pageRow)
      expect(trashBtn).toBeTruthy()
    })

    it('shows AlertDialog when trash icon is clicked', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage('P1', 'Deletable Page')],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Deletable Page')

      // Find and click the trash button (has aria-label)
      const pageRow = screen.getByText('Deletable Page').closest('.group') as HTMLElement
      const trashBtn = findTrashButton(pageRow)
      await user.click(trashBtn)

      // AlertDialog should appear with title and page name in description
      expect(await screen.findByText(/Delete page\?/i)).toBeInTheDocument()
      // The page name appears both in the list (aria-hidden) and dialog description
      expect(screen.getAllByText(/Deletable Page/).length).toBeGreaterThanOrEqual(1)
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument()
    })

    it('cancelling the dialog keeps the page', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage('P1', 'Keep This Page')],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Keep This Page')

      // Open dialog
      const pageRow = screen.getByText('Keep This Page').closest('.group') as HTMLElement
      const trashBtn = findTrashButton(pageRow)
      await user.click(trashBtn)

      // Click Cancel
      const cancelBtn = await screen.findByRole('button', { name: /Cancel/i })
      await user.click(cancelBtn)

      // Page should still be there
      expect(screen.getByText('Keep This Page')).toBeInTheDocument()
      expect(screen.queryByText(/Delete page\?/i)).not.toBeInTheDocument()
    })

    it('confirming the dialog deletes the page', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage('P1', 'To Be Deleted')],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('To Be Deleted')

      // Mock delete_block response
      mockedInvoke.mockResolvedValueOnce({
        block_id: 'P1',
        deleted_at: '2025-01-15T00:00:00Z',
        descendants_affected: 0,
      })

      // Open dialog
      const pageRow = screen.getByText('To Be Deleted').closest('.group') as HTMLElement
      const trashBtn = findTrashButton(pageRow)
      await user.click(trashBtn)

      // Click Delete
      const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
      await user.click(confirmBtn)

      // Page should be removed
      await waitFor(() => {
        expect(screen.queryByText('To Be Deleted')).not.toBeInTheDocument()
      })

      // Verify delete_block was called
      expect(mockedInvoke).toHaveBeenCalledWith('delete_block', { blockId: 'P1' })
    })
  })

  // UX #8: Error feedback on failed operations
  describe('error feedback', () => {
    it('shows toast on failed page load', async () => {
      mockedInvoke.mockRejectedValueOnce(new Error('Network error'))

      render(<PageBrowser />)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to load pages'),
        )
      })
    })

    it('shows toast on failed page creation', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      // Mock create_block to fail
      mockedInvoke.mockRejectedValueOnce(new Error('Create failed'))

      const newPageBtn = screen.getByRole('button', { name: /New Page/i })
      await user.click(newPageBtn)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to create page'),
        )
      })
    })

    it('shows toast on failed page deletion', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage('P1', 'Fail Delete')],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Fail Delete')

      // Mock delete_block to fail
      mockedInvoke.mockRejectedValueOnce(new Error('Delete failed'))

      // Open dialog and confirm
      const pageRow = screen.getByText('Fail Delete').closest('.group') as HTMLElement
      const trashBtn = findTrashButton(pageRow)
      await user.click(trashBtn)
      const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
      await user.click(confirmBtn)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to delete page'),
        )
      })
    })
  })

  it('has no a11y violations', async () => {
    const page = {
      items: [makePage('P1', 'Accessible page')],
      next_cursor: null,
      has_more: false,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    const { container } = render(<PageBrowser />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
