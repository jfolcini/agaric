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
        agendaSource: null,
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

  it('shows skeleton loaders during initial load', () => {
    // Mock that never resolves — keeps loading state
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    const { container } = render(<PageBrowser />)

    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBe(3)
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
        agendaSource: null,
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

  // Page creation via name input form
  describe('page creation form', () => {
    it('renders an input field and submit button', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New page name...')).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /New Page/i })).toBeInTheDocument()
    })

    it('creates page with the typed name on form submit', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      // Mock create_block response
      mockedInvoke.mockResolvedValueOnce(makePage('P_NEW', 'My Custom Page'))

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'My Custom Page')
      await user.click(screen.getByRole('button', { name: /New Page/i }))

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: 'My Custom Page',
          parentId: null,
          position: null,
        })
      })

      // The new page appears in the list
      expect(await screen.findByText('My Custom Page')).toBeInTheDocument()
    })

    it('clears input after successful creation', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      mockedInvoke.mockResolvedValueOnce(makePage('P_NEW', 'Temp Name'))

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'Temp Name')
      await user.click(screen.getByRole('button', { name: /New Page/i }))

      await waitFor(() => {
        expect(input).toHaveValue('')
      })
    })

    it('disables "New Page" button when input is empty or whitespace', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      const newPageBtn = screen.getByRole('button', { name: /New Page/i })
      expect(newPageBtn).toBeDisabled()

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, '   ')
      expect(newPageBtn).toBeDisabled()

      await user.clear(input)
      await user.type(input, 'Some Page')
      expect(newPageBtn).toBeEnabled()
    })

    it('submits via Enter key in the input', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      mockedInvoke.mockResolvedValueOnce(makePage('P_ENTER', 'Enter Page'))

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'Enter Page{Enter}')

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
          blockType: 'page',
          content: 'Enter Page',
          parentId: null,
          position: null,
        })
      })
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

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'Failing Page')

      const newPageBtn = screen.getByRole('button', { name: /New Page/i })
      await user.click(newPageBtn)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to create page'),
          expect.objectContaining({
            action: expect.objectContaining({ label: 'Retry' }),
          }),
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
          expect.objectContaining({
            action: expect.objectContaining({ label: 'Retry' }),
          }),
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

  it('page item button has focus-visible ring classes', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage('P1', 'Focus Page')],
      next_cursor: null,
      has_more: false,
    })

    render(<PageBrowser />)

    await screen.findByText('Focus Page')

    const pageRow = screen.getByText('Focus Page').closest('.group') as HTMLElement
    const pageBtn = within(pageRow).getByRole('button', { name: /Focus Page/i })
    expect(pageBtn.className).toContain('focus-visible:ring-2')
    expect(pageBtn.className).toContain('focus-visible:ring-ring')
    expect(pageBtn.className).toContain('focus-visible:ring-offset-1')
  })

  it('delete button is disabled while deletion is in progress', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage('P1', 'Deleting Page')],
      next_cursor: null,
      has_more: false,
    })

    render(<PageBrowser />)

    await screen.findByText('Deleting Page')

    // Mock delete_block to return a pending promise (never resolves)
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    // Open dialog
    const pageRow = screen.getByText('Deleting Page').closest('.group') as HTMLElement
    const trashBtn = findTrashButton(pageRow)
    await user.click(trashBtn)

    // Click Delete in dialog
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    // Dialog closes but trash button should be disabled while delete is in progress
    await waitFor(() => {
      expect(trashBtn).toBeDisabled()
    })
  })

  it('success toast shown after delete', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage('P1', 'Toast Page')],
      next_cursor: null,
      has_more: false,
    })

    render(<PageBrowser />)

    await screen.findByText('Toast Page')

    // Mock delete_block response
    mockedInvoke.mockResolvedValueOnce({
      block_id: 'P1',
      deleted_at: '2025-01-15T00:00:00Z',
      descendants_affected: 0,
    })

    // Open dialog and confirm
    const pageRow = screen.getByText('Toast Page').closest('.group') as HTMLElement
    const trashBtn = findTrashButton(pageRow)
    await user.click(trashBtn)
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Page deleted')
    })
  })

  it('page name has title attribute for accessibility', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage('P1', 'A very long page name that should be truncated')],
      next_cursor: null,
      has_more: false,
    })

    render(<PageBrowser />)

    const pageTitle = await screen.findByText('A very long page name that should be truncated')
    expect(pageTitle).toHaveAttribute('title', 'A very long page name that should be truncated')
  })

  // UX #171: "New Page" button loading state
  describe('new page loading state', () => {
    it('disables "New Page" button during creation', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      // Mock create_block to return a pending promise (never resolves)
      mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'Test Page')

      const newPageBtn = screen.getByRole('button', { name: /New Page/i })
      await user.click(newPageBtn)

      // Button should be disabled while creating
      expect(newPageBtn).toBeDisabled()
    })

    it('re-enables "New Page" button after creation completes', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      // Mock create_block to resolve
      let resolveCreate!: (v: unknown) => void
      const p = new Promise((r) => {
        resolveCreate = r
      })
      mockedInvoke.mockReturnValueOnce(p)

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'Test Page')

      const newPageBtn = screen.getByRole('button', { name: /New Page/i })
      await user.click(newPageBtn)

      // Button should be disabled while creating
      expect(newPageBtn).toBeDisabled()

      // Resolve the create call
      resolveCreate(makePage('P_NEW', 'Test Page'))

      // After creation, input is cleared so button is disabled due to empty input
      await waitFor(() => {
        expect(input).toHaveValue('')
      })

      // Type new text to prove isCreating was reset — button should re-enable
      await user.type(input, 'Another Page')
      expect(newPageBtn).toBeEnabled()
    })
  })

  it('renders Export all pages button', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage('P1', 'A Page')],
      next_cursor: null,
      has_more: false,
    })

    render(<PageBrowser />)

    const exportBtn = await screen.findByRole('button', { name: /Export all pages/i })
    expect(exportBtn).toBeInTheDocument()
    expect(exportBtn).toBeEnabled()
  })

  describe('namespaced pages tree view', () => {
    it('renders flat list when no pages have namespaces', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage('P1', 'First page'), makePage('P2', 'Second page')],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      expect(await screen.findByText('First page')).toBeInTheDocument()
      expect(screen.getByText('Second page')).toBeInTheDocument()
      // Should use flat list items (listitem role)
      const listItems = screen.getAllByRole('listitem')
      expect(listItems).toHaveLength(2)
    })

    it('renders tree structure for namespaced pages', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage('P1', 'work/project-a'),
          makePage('P2', 'work/project-b'),
          makePage('P3', 'personal/journal'),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      // Namespace folders should appear
      expect(await screen.findByText('work')).toBeInTheDocument()
      expect(screen.getByText('personal')).toBeInTheDocument()

      // Leaf page names should appear (just the segment, not full path)
      expect(screen.getByText('project-a')).toBeInTheDocument()
      expect(screen.getByText('project-b')).toBeInTheDocument()
      expect(screen.getByText('journal')).toBeInTheDocument()
    })

    it('namespace folders are collapsible', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage('P1', 'work/project-a'),
          makePage('P2', 'work/project-b'),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      // Wait for tree to render — children should be visible (expanded by default)
      expect(await screen.findByText('project-a')).toBeInTheDocument()
      expect(screen.getByText('project-b')).toBeInTheDocument()

      // Click the "work" folder button to collapse it
      const workFolder = screen.getByText('work')
      await user.click(workFolder)

      // Children should be hidden
      expect(screen.queryByText('project-a')).not.toBeInTheDocument()
      expect(screen.queryByText('project-b')).not.toBeInTheDocument()

      // Folder label still visible
      expect(screen.getByText('work')).toBeInTheDocument()

      // Click again to expand
      await user.click(workFolder)

      // Children should reappear
      expect(screen.getByText('project-a')).toBeInTheDocument()
      expect(screen.getByText('project-b')).toBeInTheDocument()
    })

    it('fires onPageSelect with full path when a tree leaf is clicked', async () => {
      const user = userEvent.setup()
      const onPageSelect = vi.fn()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage('P1', 'work/project-a')],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser onPageSelect={onPageSelect} />)

      const leaf = await screen.findByText('project-a')
      await user.click(leaf)

      expect(onPageSelect).toHaveBeenCalledWith('P1', 'work/project-a')
    })
  })

  describe('create page under namespace', () => {
    it('namespace folder shows + button', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage('P1', 'work/project-a')],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('work')

      const createBtn = screen.getByRole('button', { name: /create page under work/i })
      expect(createBtn).toBeInTheDocument()
    })

    it('clicking + on namespace prefills input', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage('P1', 'work/project-a')],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('work')

      const createBtn = screen.getByRole('button', { name: /create page under work/i })
      await user.click(createBtn)

      const input = screen.getByPlaceholderText('New page name...')
      expect(input).toHaveValue('work/')
    })

    it('a11y: + button has proper aria-label with namespace path', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage('P1', 'work/dev/task-1'),
          makePage('P2', 'work/dev/task-2'),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('work')

      // Both namespace levels should have proper aria-labels
      expect(screen.getByRole('button', { name: 'Create page under work' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Create page under work/dev' })).toBeInTheDocument()
    })
  })
})
