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
import { emptyPage, makePage } from '../../__tests__/fixtures'
import { PageBrowser } from '../PageBrowser'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  const Ctx = React.createContext({})

  function Select({ value, onValueChange, children, disabled }: any) {
    const triggerPropsRef = React.useRef({})
    return React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange, triggerPropsRef, disabled } },
      children,
    )
  }

  function SelectTrigger({ size, className, ...props }: any) {
    const ctx = React.useContext(Ctx)
    Object.assign(ctx.triggerPropsRef.current, { size, className, ...props })
    return null
  }

  function SelectValue() {
    return null
  }

  function SelectContent({ children }: any) {
    const ctx = React.useContext(Ctx)
    const tp = ctx.triggerPropsRef.current
    return React.createElement(
      'select',
      {
        value: ctx.value ?? '',
        onChange: (e: any) => ctx.onValueChange?.(e.target.value),
        disabled: ctx.disabled,
        'aria-label': tp['aria-label'],
        className: tp.className,
        'data-size': tp.size,
      },
      children,
    )
  }

  function SelectItem({ value, children }: any) {
    return React.createElement('option', { value }, children)
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

vi.mock('@/lib/recent-pages', () => ({
  getRecentPages: vi.fn(() => []),
}))

import { getRecentPages } from '@/lib/recent-pages'

const mockedGetRecentPages = vi.mocked(getRecentPages)

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

/** Find the trash (delete) button within a page row via its aria-label. */
function findTrashButton(row: HTMLElement): HTMLButtonElement {
  return within(row).getByRole('button', { name: /delete page/i })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem('page-browser-sort')
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
        agendaDateRange: null,
        agendaSource: null,
        cursor: null,
        limit: 50,
      })
    })
  })

  it('renders pages when data is returned', async () => {
    const page = {
      items: [
        makePage({ id: 'P1', content: 'First page' }),
        makePage({ id: 'P2', content: 'Second page' }),
      ],
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
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
  })

  it('shows Untitled for pages with null content', async () => {
    const page = {
      items: [makePage({ id: 'P1', content: null })],
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
      items: [makePage({ id: 'P1', content: 'Page 1' })],
      next_cursor: 'cursor_abc',
      has_more: true,
    }
    const page2 = {
      items: [makePage({ id: 'P2', content: 'Page 2' })],
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
        agendaDateRange: null,
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
      items: [makePage({ id: 'P1', content: 'Click me' })],
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
        items: [makePage({ id: 'P1', content: 'My Page' })],
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
        items: [makePage({ id: 'P1', content: 'Deletable Page' })],
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
        items: [makePage({ id: 'P1', content: 'Keep This Page' })],
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
        items: [makePage({ id: 'P1', content: 'To Be Deleted' })],
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
      mockedInvoke.mockResolvedValueOnce(makePage({ id: 'P_NEW', content: 'My Custom Page' }))

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

      mockedInvoke.mockResolvedValueOnce(makePage({ id: 'P_NEW', content: 'Temp Name' }))

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

      mockedInvoke.mockResolvedValueOnce(makePage({ id: 'P_ENTER', content: 'Enter Page' }))

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

    it('navigates to the new page after creation via onPageSelect', async () => {
      const user = userEvent.setup()
      const onPageSelect = vi.fn()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser onPageSelect={onPageSelect} />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      mockedInvoke.mockResolvedValueOnce(makePage({ id: 'P_NAV', content: 'Navigate Here' }))

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'Navigate Here')
      await user.click(screen.getByRole('button', { name: /New Page/i }))

      await waitFor(() => {
        expect(onPageSelect).toHaveBeenCalledWith('P_NAV', 'Navigate Here')
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
        items: [makePage({ id: 'P1', content: 'Fail Delete' })],
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
      items: [makePage({ id: 'P1', content: 'Accessible page' })],
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
      items: [makePage({ id: 'P1', content: 'Focus Page' })],
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
      items: [makePage({ id: 'P1', content: 'Deleting Page' })],
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
      items: [makePage({ id: 'P1', content: 'Toast Page' })],
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
      items: [makePage({ id: 'P1', content: 'A very long page name that should be truncated' })],
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
      resolveCreate(makePage({ id: 'P_NEW', content: 'Test Page' }))

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
      items: [makePage({ id: 'P1', content: 'A Page' })],
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
        items: [
          makePage({ id: 'P1', content: 'First page' }),
          makePage({ id: 'P2', content: 'Second page' }),
        ],
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
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work/project-b' }),
          makePage({ id: 'P3', content: 'personal/journal' }),
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
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work/project-b' }),
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
        items: [makePage({ id: 'P1', content: 'work/project-a' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser onPageSelect={onPageSelect} />)

      const leaf = await screen.findByText('project-a')
      await user.click(leaf)

      expect(onPageSelect).toHaveBeenCalledWith('P1', 'work/project-a')
    })

    it('renders hybrid node (page with children) as navigable folder', async () => {
      const user = userEvent.setup()
      const onPageSelect = vi.fn()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work' }),
          makePage({ id: 'P2', content: 'work/project-a' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser onPageSelect={onPageSelect} />)

      // "work" should be visible as a clickable name
      const workName = await screen.findByText('work')
      expect(workName).toBeInTheDocument()

      // "project-a" child should be visible (expanded by default)
      expect(screen.getByText('project-a')).toBeInTheDocument()

      // Clicking the "work" name should navigate to the work page
      await user.click(workName)
      expect(onPageSelect).toHaveBeenCalledWith('P1', 'work')
    })

    it('hybrid node can be collapsed to hide children', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work' }),
          makePage({ id: 'P2', content: 'work/project-a' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      // Children should be visible initially
      expect(await screen.findByText('project-a')).toBeInTheDocument()

      // Find the chevron toggle button (sibling of the name button)
      const workName = screen.getByText('work')
      const headerRow = workName.closest('.group') as HTMLElement
      const buttons = within(headerRow).getAllByRole('button')
      // First button is the chevron toggle
      const chevronBtn = buttons[0] as HTMLElement
      await user.click(chevronBtn)

      // Children should be hidden
      expect(screen.queryByText('project-a')).not.toBeInTheDocument()

      // Folder label still visible
      expect(screen.getByText('work')).toBeInTheDocument()

      // Click again to expand
      await user.click(chevronBtn)
      expect(screen.getByText('project-a')).toBeInTheDocument()
    })

    it('tree leaf items have a delete button that triggers confirmation dialog', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work/project-b' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('project-a')

      // Find the delete button for project-a via aria-label
      const deleteBtn = screen.getByRole('button', { name: 'Delete work/project-a' })
      expect(deleteBtn).toBeInTheDocument()

      await user.click(deleteBtn)

      // Confirmation dialog should appear
      expect(await screen.findByText(/Delete page\?/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument()
    })

    it('tree leaf items render with a file icon', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'work/project-a' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('project-a')

      // The leaf item should contain an SVG icon (FileText from lucide-react)
      const leafButton = screen.getByText('project-a').closest('button') as HTMLElement
      const svg = leafButton.querySelector('svg')
      expect(svg).toBeTruthy()
      expect(svg?.classList.contains('h-4')).toBe(true)
      expect(svg?.classList.contains('w-4')).toBe(true)
    })
  })

  describe('create page under namespace', () => {
    it('namespace folder shows + button', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'work/project-a' })],
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
        items: [makePage({ id: 'P1', content: 'work/project-a' })],
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
          makePage({ id: 'P1', content: 'work/dev/task-1' }),
          makePage({ id: 'P2', content: 'work/dev/task-2' }),
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

  describe('search/filter', () => {
    it('search filters pages and shows only matches', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Meeting notes' }),
          makePage({ id: 'P2', content: 'Shopping list' }),
          makePage({ id: 'P3', content: 'Meeting agenda' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Meeting')

      // Matching pages visible (title attribute stays intact despite highlight)
      expect(screen.getByTitle('Meeting notes')).toBeInTheDocument()
      expect(screen.getByTitle('Meeting agenda')).toBeInTheDocument()
      // Non-matching page hidden
      expect(screen.queryByTitle('Shopping list')).not.toBeInTheDocument()
    })

    it('search filters namespaced pages and expands matching ancestors', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work/project-b' }),
          makePage({ id: 'P3', content: 'personal/journal' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('project-a')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'project-a')

      // Matching page should be visible
      expect(screen.getByText(/project-a/)).toBeInTheDocument()
      // Ancestor folder should be visible
      expect(screen.getByText('work')).toBeInTheDocument()
      // Non-matching pages should not be visible
      expect(screen.queryByText('project-b')).not.toBeInTheDocument()
      expect(screen.queryByText('journal')).not.toBeInTheDocument()
      expect(screen.queryByText('personal')).not.toBeInTheDocument()
    })

    it('search with no matches shows empty state', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Meeting notes' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'zzz-nonexistent')

      expect(screen.queryByText('Meeting notes')).not.toBeInTheDocument()
      expect(screen.getByText('No matching pages')).toBeInTheDocument()
    })

    it('search is case-insensitive', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Meeting Notes' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Meeting Notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'meeting')

      expect(screen.getByTitle('Meeting Notes')).toBeInTheDocument()
    })

    it('clearing search shows all pages again', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Meeting notes' }),
          makePage({ id: 'P2', content: 'Shopping list' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Meeting')

      expect(screen.queryByText('Shopping list')).not.toBeInTheDocument()

      await user.clear(searchInput)

      expect(screen.getByText('Meeting notes')).toBeInTheDocument()
      expect(screen.getByText('Shopping list')).toBeInTheDocument()
    })
  })

  describe('sort dropdown', () => {
    it('renders sort dropdown with 3 options', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'A Page' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('A Page')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      expect(sortSelect).toBeInTheDocument()

      const options = within(sortSelect).getAllByRole('option')
      expect(options).toHaveLength(3)
      expect(options.map((o) => o.textContent)).toEqual(['Alphabetical', 'Recent', 'Created'])
    })

    it('defaults to Alphabetical sort', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'A Page' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('A Page')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      expect(sortSelect).toHaveValue('alphabetical')
    })

    it('sorts pages alphabetically by default', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Cherry' }),
          makePage({ id: 'P2', content: 'Apple' }),
          makePage({ id: 'P3', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Apple')

      const listItems = screen.getAllByRole('listitem')
      const titles = listItems.map(
        (li) => li.querySelector('.page-browser-item-title')?.textContent,
      )
      expect(titles).toEqual(['Apple', 'Banana', 'Cherry'])
    })

    it('switching to Created sort orders pages by ULID descending (newest first)', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: '01AAA', content: 'Oldest' }),
          makePage({ id: '01CCC', content: 'Newest' }),
          makePage({ id: '01BBB', content: 'Middle' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Oldest')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'created')

      const listItems = screen.getAllByRole('listitem')
      const titles = listItems.map(
        (li) => li.querySelector('.page-browser-item-title')?.textContent,
      )
      expect(titles).toEqual(['Newest', 'Middle', 'Oldest'])
    })

    it('switching to Recent sort uses recent-pages store', async () => {
      const user = userEvent.setup()
      mockedGetRecentPages.mockReturnValue([
        { id: 'P2', title: 'Banana', visitedAt: '2025-01-15T12:00:00Z' },
        { id: 'P3', title: 'Cherry', visitedAt: '2025-01-14T12:00:00Z' },
      ])
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
          makePage({ id: 'P3', content: 'Cherry' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'recent')

      const listItems = screen.getAllByRole('listitem')
      const titles = listItems.map(
        (li) => li.querySelector('.page-browser-item-title')?.textContent,
      )
      // Banana (most recent), Cherry (second recent), Apple (not in recent, alphabetical fallback)
      expect(titles).toEqual(['Banana', 'Cherry', 'Apple'])
    })

    it('persists sort preference to localStorage', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'A Page' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('A Page')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'created')

      expect(localStorage.getItem('page-browser-sort')).toBe('created')
    })

    it('reads persisted sort preference from localStorage', async () => {
      localStorage.setItem('page-browser-sort', 'recent')

      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'A Page' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('A Page')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      expect(sortSelect).toHaveValue('recent')
    })

    it('sort dropdown passes a11y audit', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Accessible page' })],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)

      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })
  })
})
