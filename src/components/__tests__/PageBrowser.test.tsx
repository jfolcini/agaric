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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { emptyPage, makePage } from '../../__tests__/fixtures'
import { useSpaceStore } from '../../stores/space'
import { PageBrowser } from '../PageBrowser'

// Mock @tanstack/react-virtual to render all items (jsdom has zero-height containers)
vi.mock('@tanstack/react-virtual', () => {
  const scrollToIndex = vi.fn()
  const measureElement = () => {}
  return {
    useVirtualizer: (opts: { count: number; estimateSize: () => number }) => ({
      getVirtualItems: () =>
        Array.from({ length: opts.count }, (_, i) => ({
          index: i,
          key: i,
          start: i * opts.estimateSize(),
          size: opts.estimateSize(),
          end: (i + 1) * opts.estimateSize(),
        })),
      getTotalSize: () => opts.count * opts.estimateSize(),
      scrollToIndex,
      measureElement,
    }),
  }
})

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

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
  localStorage.removeItem('starred-pages')
  // FEAT-3 Phase 2 — PageBrowser now gates its render and listBlocks
  // call on `useSpaceStore.isReady`. Seed the store so tests exercise
  // the real code path rather than the loading skeleton.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [
      { id: 'SPACE_TEST', name: 'Test', accent_color: null },
      { id: 'SPACE_OTHER', name: 'Other', accent_color: null },
    ],
    isReady: true,
  })
  // Default fallback: resolve_page_by_alias returns null (no alias match)
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
    return Promise.resolve(undefined)
  })
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
        agenda: null,
        cursor: null,
        limit: 50,
        spaceId: 'SPACE_TEST',
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
        agenda: null,
        cursor: 'cursor_abc',
        limit: 50,
        spaceId: 'SPACE_TEST',
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
      expect(pageRow).toBeInTheDocument()
      // There should be at least 2 buttons: page select and trash
      const allButtons = pageRow.querySelectorAll('button')
      expect(allButtons.length).toBeGreaterThanOrEqual(2)
      // The trash button has an aria-label
      const trashBtn = findTrashButton(pageRow)
      expect(trashBtn).toBeInTheDocument()
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

    // UX-212: input has accessible name via Label htmlFor
    it('new page input has accessible name via sr-only label (UX-212)', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      const input = await screen.findByRole('textbox', {
        name: t('pageBrowser.createPageInputLabel'),
      })
      expect(input).toBeInTheDocument()
      expect(input).toHaveAttribute('id', 'new-page-name')
    })

    it('creates page with the typed name on form submit', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      // Mock create_page_in_space response — atomic wrapper returns the new page's ULID
      mockedInvoke.mockResolvedValueOnce('P_NEW')

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'My Custom Page')
      await user.click(screen.getByRole('button', { name: /New Page/i }))

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
          parentId: null,
          content: 'My Custom Page',
          spaceId: 'SPACE_TEST',
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

      mockedInvoke.mockResolvedValueOnce('P_NEW')

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

      mockedInvoke.mockResolvedValueOnce('P_ENTER')

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'Enter Page{Enter}')

      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('create_page_in_space', {
          parentId: null,
          content: 'Enter Page',
          spaceId: 'SPACE_TEST',
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

      mockedInvoke.mockResolvedValueOnce('P_NAV')

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

      // Mock create_page_in_space to fail
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
    expect(pageBtn.className).toContain('focus-visible:ring-[3px]')
    expect(pageBtn.className).toContain('focus-visible:ring-ring/50')
    expect(pageBtn.className).toContain('focus-visible:outline-hidden')
    // UX-237: focus ring must be inset so the inner ScrollArea's
    // `overflow-hidden` does not clip its left/right legs.
    expect(pageBtn).toHaveClass('focus-visible:ring-inset')
  })

  it('UX-11: focused page row highlights with bg only — focus ring lives on the inner button', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Inset Page' })],
      next_cursor: null,
      has_more: false,
    })

    render(<PageBrowser />)

    await screen.findByText('Inset Page')

    // focusedIndex defaults to 0, so the first (and only) virtualized row
    // renders selected with the keyboard-navigation highlight class.
    // `data-page-item` scopes away the native <option> elements in the
    // sort <select> which share role="option".
    const focusedRow = document.querySelector(
      '[data-page-item][aria-selected="true"]',
    ) as HTMLElement | null
    expect(focusedRow).not.toBeNull()
    // Row paints only the highlight background; the focus ring lives on the
    // inner <button>'s `focus-visible:ring-[3px]` to avoid double-stacking.
    expect(focusedRow).toHaveClass('bg-accent/30')
    expect(focusedRow).not.toHaveClass('ring-2')
    expect(focusedRow).not.toHaveClass('ring-ring/50')

    // The inner button still carries the focus-visible ring so keyboard
    // users see exactly one ring when the row is focused.
    const innerBtn = focusedRow
      ? within(focusedRow).getByRole('button', { name: /Inset Page/i })
      : null
    expect(innerBtn).not.toBeNull()
    expect(innerBtn?.className).toContain('focus-visible:ring-[3px]')
    expect(innerBtn?.className).toContain('focus-visible:ring-inset')
  })

  it('UX-237: star-toggle and delete buttons have ring-inset focus rings', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Inset Buttons Page' })],
      next_cursor: null,
      has_more: false,
    })

    render(<PageBrowser />)

    await screen.findByText('Inset Buttons Page')

    const pageRow = screen.getByText('Inset Buttons Page').closest('.group') as HTMLElement
    const starBtn = within(pageRow).getByRole('button', { name: /star page/i })
    const deleteBtn = findTrashButton(pageRow)
    expect(starBtn).toHaveClass('focus-visible:ring-inset')
    expect(deleteBtn).toHaveClass('focus-visible:ring-inset')
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

      // Mock create_page_in_space to return a pending promise (never resolves)
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

      // Mock create_page_in_space to resolve
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

      // Resolve the create call — wrapper returns the new page's ULID
      resolveCreate('P_NEW')

      // After creation, input is cleared so button is disabled due to empty input
      await waitFor(() => {
        expect(input).toHaveValue('')
      })

      // Type new text to prove isCreating was reset — button should re-enable
      await user.type(input, 'Another Page')
      expect(newPageBtn).toBeEnabled()
    })
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
      // Should use flat list items (option role inside listbox)
      const listbox = screen.getByRole('listbox')
      const listItems = within(listbox).getAllByRole('option')
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

    // UX-259: Delete is destructive — Cancel must be auto-focused so reflex
    // Enter dismisses instead of permanently deleting the page. We assert
    // focus state + no-mutation rather than dialog dismissal alone, because
    // jsdom's autoFocus + Radix focus-trap timing can lag the Enter event.
    it('UX-259: reflex Enter on delete dialog does NOT call trash_page', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'work/project-a' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('project-a')

      const deleteBtn = screen.getByRole('button', { name: 'Delete work/project-a' })
      await user.click(deleteBtn)
      expect(await screen.findByText(/Delete page\?/i)).toBeInTheDocument()

      // Wait for Cancel to receive focus (autoFocus is applied in a
      // post-mount effect by Radix).
      const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
      await waitFor(() => {
        expect(cancelBtn).toHaveFocus()
      })

      // Reflex Enter on the focused Cancel button must NOT trigger the
      // destructive action.
      await user.keyboard('{Enter}')

      // No mutation IPC should have fired.
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'trash_page')).toHaveLength(0)
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_page')).toHaveLength(0)
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
      expect(svg).toBeInTheDocument()
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

    // UX-247 — Unicode-aware filter regression tests.  Plain
    // `.toLowerCase().includes(...)` fails these cases; the filter
    // now delegates to `matchesSearchFolded` in `@/lib/fold-for-search`.

    it('search matches Turkish İstanbul when query is lowercase istanbul', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'İstanbul' }),
          makePage({ id: 'P2', content: 'Ankara' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('İstanbul')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'istanbul')

      expect(screen.getByTitle('İstanbul')).toBeInTheDocument()
      expect(screen.queryByText('Ankara')).not.toBeInTheDocument()
    })

    it('search matches German Straße when query is ASCII strasse', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Straße' }),
          makePage({ id: 'P2', content: 'München' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Straße')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'strasse')

      expect(screen.getByTitle('Straße')).toBeInTheDocument()
      expect(screen.queryByText('München')).not.toBeInTheDocument()
    })

    it('search matches accented café when query omits the accent', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'café meeting' }),
          makePage({ id: 'P2', content: 'lunch' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('café meeting')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'cafe')

      expect(screen.getByTitle('café meeting')).toBeInTheDocument()
      expect(screen.queryByText('lunch')).not.toBeInTheDocument()
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

      const listItems = within(screen.getByRole('listbox')).getAllByRole('option')
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

      const listItems = within(screen.getByRole('listbox')).getAllByRole('option')
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

      const listItems = within(screen.getByRole('listbox')).getAllByRole('option')
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

  describe('starred pages', () => {
    it('renders star icon on each page', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Page One' }),
          makePage({ id: 'P2', content: 'Page Two' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Page One')

      const starButtons = screen.getAllByRole('button', { name: /star page/i })
      expect(starButtons).toHaveLength(2)
    })

    // FEAT-12: clicking the star toggle moves the page between groups.
    // With a 1-page vault we render flat (no headers) — so this test
    // pairs with the multi-page case below which asserts the row jump.
    it('clicking star toggles starred state and persists to localStorage', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Starrable Page' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)

      await screen.findByText('Starrable Page')

      // Initially unstarred
      const starBtn = screen.getByRole('button', { name: /star page/i })
      expect(starBtn).toBeInTheDocument()

      // Click to star
      await user.click(starBtn)

      // Should now show "Unstar page" aria-label
      expect(screen.getByRole('button', { name: /unstar page/i })).toBeInTheDocument()
      expect(localStorage.getItem('starred-pages')).toBe(JSON.stringify(['P1']))

      // Click to unstar
      await user.click(screen.getByRole('button', { name: /unstar page/i }))

      // Should be back to "Star page"
      expect(screen.getByRole('button', { name: /star page/i })).toBeInTheDocument()
      expect(localStorage.getItem('starred-pages')).toBe(JSON.stringify([]))
    })

    // FEAT-12: starring a page in a multi-page vault moves it to the top
    // of the list under the "Starred" group header.
    it('clicking star moves the page to the top under the Starred header (FEAT-12)', async () => {
      const user = userEvent.setup()
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

      // Initially flat — no Starred header.
      expect(screen.queryByText('Starred')).not.toBeInTheDocument()
      let titles = within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.querySelector('.page-browser-item-title')?.textContent)
      expect(titles).toEqual(['Apple', 'Banana', 'Cherry'])

      // Star "Cherry" — its row should jump to the top, into the
      // newly-rendered Starred group.
      const cherryRow = screen.getByText('Cherry').closest('.group') as HTMLElement
      const starBtn = within(cherryRow).getByRole('button', { name: /star page/i })
      await user.click(starBtn)

      // Starred header now visible.
      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()

      // Cherry is now first in the page-only listbox.
      titles = within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.querySelector('.page-browser-item-title')?.textContent)
      expect(titles).toEqual(['Cherry', 'Apple', 'Banana'])

      // The starred row carries `data-starred="true"`.
      const starredRow = screen.getByText('Cherry').closest('[data-page-item]') as HTMLElement
      expect(starredRow).toHaveAttribute('data-starred', 'true')
    })

    // FEAT-12: starred-above-unstarred ordering with sort applied
    // independently per group.
    it('FEAT-12: alphabetical sort applies inside each group independently', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P3', 'P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Cherry' }),
          makePage({ id: 'P2', content: 'Apple' }),
          makePage({ id: 'P3', content: 'Banana' }),
          makePage({ id: 'P4', content: 'Durian' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Default sort is alphabetical. Starred set = {Cherry, Banana};
      // Other = {Apple, Durian}. Within each group: alphabetical.
      const titles = within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.querySelector('.page-browser-item-title')?.textContent)
      expect(titles).toEqual(['Banana', 'Cherry', 'Apple', 'Durian'])
    })

    it('FEAT-12: created-DESC sort applies inside each group independently', async () => {
      const user = userEvent.setup()
      localStorage.setItem('starred-pages', JSON.stringify(['01AAA', '01CCC']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: '01AAA', content: 'OldStar' }),
          makePage({ id: '01BBB', content: 'MidUnstar' }),
          makePage({ id: '01CCC', content: 'NewStar' }),
          makePage({ id: '01DDD', content: 'NewestUnstar' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('OldStar')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'created')

      // Starred (newest-first): NewStar, OldStar
      // Other (newest-first):   NewestUnstar, MidUnstar
      const titles = within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.querySelector('.page-browser-item-title')?.textContent)
      expect(titles).toEqual(['NewStar', 'OldStar', 'NewestUnstar', 'MidUnstar'])
    })

    it('FEAT-12: recent sort applies inside each group independently', async () => {
      const user = userEvent.setup()
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2']))
      mockedGetRecentPages.mockReturnValue([
        { id: 'P3', title: 'Cherry', visitedAt: '2025-01-15T12:00:00Z' },
        { id: 'P1', title: 'Apple', visitedAt: '2025-01-14T12:00:00Z' },
      ])
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
          makePage({ id: 'P3', content: 'Cherry' }),
          makePage({ id: 'P4', content: 'Durian' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'recent')

      // Starred = {Apple, Banana} — Apple has a recent visit, Banana does not
      // (alphabetical fallback). Other = {Cherry, Durian} — Cherry recent, Durian not.
      const titles = within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.querySelector('.page-browser-item-title')?.textContent)
      expect(titles).toEqual(['Apple', 'Banana', 'Cherry', 'Durian'])
    })

    it('FEAT-12: toggling star round-trips a page between groups', async () => {
      const user = userEvent.setup()
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

      // Star Banana → moves to top under Starred.
      const bananaRow = screen.getByText('Banana').closest('.group') as HTMLElement
      await user.click(within(bananaRow).getByRole('button', { name: /star page/i }))

      expect(screen.getByText('Starred')).toBeInTheDocument()
      let titles = within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.querySelector('.page-browser-item-title')?.textContent)
      expect(titles).toEqual(['Banana', 'Apple', 'Cherry'])

      // Unstar Banana → falls back into Pages, the Starred header
      // disappears (no starred pages remain).
      const bananaRowAgain = screen.getByText('Banana').closest('.group') as HTMLElement
      await user.click(within(bananaRowAgain).getByRole('button', { name: /unstar page/i }))

      expect(screen.queryByText('Starred')).not.toBeInTheDocument()
      titles = within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.querySelector('.page-browser-item-title')?.textContent)
      expect(titles).toEqual(['Apple', 'Banana', 'Cherry'])
    })

    it('FEAT-14: namespaced pages render under the unified Pages section alongside Starred', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
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

      // Under FEAT-14 the unified model NO LONGER bypasses Starred when
      // namespaced pages are present. Starred renders the starred-and-
      // namespaced page (full title); Pages renders the namespace tree.
      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()
      // Namespace tree shape intact under Pages.
      expect(screen.getByText('work')).toBeInTheDocument()
      // Both leaves still reachable inside the tree.
      expect(screen.getByText('project-a')).toBeInTheDocument()
      expect(screen.getByText('project-b')).toBeInTheDocument()
    })

    it('FEAT-12: zero-starred hides the Starred header', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      // Spec: "zero starred → hide the Starred header (no empty section)".
      // The non-empty "Pages" section keeps its own header.
      expect(container.querySelector('[data-page-section="starred"]')).toBeNull()
      expect(container.querySelector('[data-page-section="pages"]')).not.toBeNull()
    })

    it('FEAT-12: all-starred hides the Pages header', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.queryByText('Pages')).not.toBeInTheDocument()
    })

    it('FEAT-12: single-page vault renders flat with no headers', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Solo' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Solo')

      expect(screen.queryByText('Starred')).not.toBeInTheDocument()
      expect(screen.queryByText('Pages')).not.toBeInTheDocument()
    })

    it('FEAT-12: search narrows both groups; emptied group hides its header', async () => {
      const user = userEvent.setup()
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'StarredApple' }),
          makePage({ id: 'P2', content: 'OtherBanana' }),
          makePage({ id: 'P3', content: 'OtherCherry' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('StarredApple')

      // Both headers visible at start.
      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()

      // Search for "Other" → starred group becomes empty, only the
      // "Pages" header remains.
      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Other')

      expect(screen.queryByText('Starred')).not.toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()
      expect(screen.queryByText('StarredApple')).not.toBeInTheDocument()
    })

    it('FEAT-12: Starred header carries count in its accessible name', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1', 'P2']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
          makePage({ id: 'P3', content: 'Cherry' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      const starredGroup = container.querySelector(
        '[data-page-section="starred"]',
      ) as HTMLElement | null
      expect(starredGroup).not.toBeNull()
      expect(starredGroup).toHaveAttribute('role', 'group')
      // Accessible name is "Starred, 2 pages" (sr-only span).
      expect(starredGroup).toHaveAccessibleName('Starred, 2 pages')

      const pagesGroup = container.querySelector(
        '[data-page-section="pages"]',
      ) as HTMLElement | null
      expect(pagesGroup).not.toBeNull()
      expect(pagesGroup).toHaveAccessibleName('Pages, 1 page')
    })

    it('FEAT-12: viewport aria-label switches to grouped variant when starred exist', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const listbox = screen.getByRole('listbox')
      expect(listbox).toHaveAttribute('aria-label', 'Page list, grouped by starred')
    })

    it('FEAT-12: viewport aria-label stays plain when no starred pages', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const listbox = screen.getByRole('listbox')
      expect(listbox).toHaveAttribute('aria-label', 'Page list')
    })

    it('FEAT-12: keyboard ArrowDown skips header rows (focus stays page-indexed)', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P2']))
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

      // Page-only ordering: [Banana (starred), Apple, Cherry]. Focus
      // starts at index 0 → Banana.
      const initialFocused = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(initialFocused).not.toBeNull()
      expect(initialFocused?.querySelector('.page-browser-item-title')?.textContent).toBe('Banana')

      // ArrowDown → focus the next page (Apple) — header row is skipped
      // by the page-only iterator inside `useListKeyboardNavigation`.
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      const nextFocused = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(nextFocused?.querySelector('.page-browser-item-title')?.textContent).toBe('Apple')

      // End → jumps to last page (Cherry).
      fireEvent.keyDown(document, { key: 'End' })
      const endFocused = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(endFocused?.querySelector('.page-browser-item-title')?.textContent).toBe('Cherry')

      // Home → jumps back to first page (Banana).
      fireEvent.keyDown(document, { key: 'Home' })
      const homeFocused = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(homeFocused?.querySelector('.page-browser-item-title')?.textContent).toBe('Banana')
    })

    it('FEAT-12: a11y audit passes on grouped state', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Starred Page' }),
          makePage({ id: 'P2', content: 'Normal Page' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Starred Page')

      // Both group headers must render.
      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()

      await waitFor(async () => {
        const results = await axe(container, {
          rules: {
            // listbox+option pattern intentionally nests interactive
            // star/select/delete buttons in each row.
            'nested-interactive': { enabled: false },
          },
        })
        expect(results).toHaveNoViolations()
      })
    })

    it('FEAT-12: a11y audit passes on filtered state with grouping', async () => {
      const user = userEvent.setup()
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Starred Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Starred Apple')

      // Filter to only the starred match.
      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Apple')

      await waitFor(async () => {
        const results = await axe(container, {
          rules: { 'nested-interactive': { enabled: false } },
        })
        expect(results).toHaveNoViolations()
      })
    })

    // ---------------------------------------------------------------
    // FEAT-14: unified Starred + Pages model
    // ---------------------------------------------------------------

    it('FEAT-14: starred (non-namespaced) and namespaced pages coexist', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'work/foo' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      // Starred section renders the starred flat page.
      expect(screen.getByText('Starred')).toBeInTheDocument()
      // Pages section renders the namespace tree.
      expect(screen.getByText('Pages')).toBeInTheDocument()
      expect(screen.getByText('work')).toBeInTheDocument()
      // The flat starred page lives inside the Starred section group.
      const starredGroup = container.querySelector(
        '[data-page-section="starred"]',
      ) as HTMLElement | null
      expect(starredGroup).not.toBeNull()
      // The leaf inside `work` resolves to `foo`.
      expect(screen.getByText('foo')).toBeInTheDocument()
    })

    it('FEAT-14: top-level flat pages and namespace roots interleave under Pages alphabetically', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Inbox' }),
          makePage({ id: 'P2', content: 'work/foo' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Inbox')

      // Pages section renders both an `Inbox` flat row and a `work`
      // namespace root, sorted together alphabetically.
      expect(screen.getByText('Pages')).toBeInTheDocument()
      // Walk each rendered page row in DOM order — `Inbox` (option) +
      // `work` (tree-page wrapper). Alphabetical => Inbox before work.
      const pageRows = Array.from(
        container.querySelectorAll('[data-page-item], [data-page-tree-row]'),
      ) as HTMLElement[]
      expect(pageRows).toHaveLength(2)
      // First row: Inbox (option/flat).
      expect(pageRows[0]?.textContent).toMatch(/Inbox/)
      // Second row: work (tree wrapper).
      expect(pageRows[1]?.textContent).toMatch(/work/)
    })

    it('FEAT-14: a starred-and-namespaced page renders TWICE — once in Starred, once nested in Pages', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/foo' }),
          makePage({ id: 'P2', content: 'Inbox' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Inbox')

      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()

      // The starred copy renders the FULL title `work/foo`.
      expect(screen.getByText('work/foo')).toBeInTheDocument()
      // The tree leaf inside `work` renders just the segment `foo`.
      // `getAllByText('foo')` returns the leaf-segment match (1 node);
      // the full-title match `work/foo` is found via `getByText` above.
      expect(screen.getAllByText('foo')).toHaveLength(1)
      // `work` namespace root renders.
      expect(screen.getByText('work')).toBeInTheDocument()
    })

    it('FEAT-14: star toggle from either copy of a duplicated row updates BOTH copies', async () => {
      const user = userEvent.setup()
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'work/foo' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('work/foo')

      // Starred section renders the starred copy (full-title flat row
      // with the unstar affordance). Clicking unstar should:
      //   1. Drop the row from Starred (Starred section disappears).
      //   2. Mark the leaf inside `work` as unstarred too — only the
      //      `Pages` section remains.
      const starredCopy = screen.getByText('work/foo').closest('[data-page-item]') as HTMLElement
      const unstarBtn = within(starredCopy).getByRole('button', { name: /unstar page/i })
      await user.click(unstarBtn)

      // Starred section gone — both copies refreshed via
      // `starredRevision`.
      expect(screen.queryByText('Starred')).not.toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()
      // The tree-leaf copy is still visible.
      expect(screen.getByText('foo')).toBeInTheDocument()
    })

    it('FEAT-14: filter narrows Pages to empty → Pages header hides, Starred remains', async () => {
      const user = userEvent.setup()
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'StarredApple' }),
          makePage({ id: 'P2', content: 'work/foo' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('StarredApple')

      // Both sections render initially.
      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()

      const search = screen.getByPlaceholderText('Search pages...')
      await user.type(search, 'StarredApple')

      // Starred-only — Pages header hidden.
      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.queryByText('Pages')).not.toBeInTheDocument()
    })

    it('FEAT-14: filter narrows Starred to empty → Starred header hides, Pages remains', async () => {
      const user = userEvent.setup()
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'StarredApple' }),
          makePage({ id: 'P2', content: 'work/foo' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('StarredApple')

      const search = screen.getByPlaceholderText('Search pages...')
      await user.type(search, 'work')

      // Pages-only — Starred header hidden.
      expect(screen.queryByText('Starred')).not.toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()
      expect(screen.getByText('work')).toBeInTheDocument()
    })

    it('FEAT-14: keyboard ArrowDown walks every visible row in render order, including duplicates', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/foo' }),
          makePage({ id: 'P2', content: 'Inbox' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Inbox')

      // Render order under FEAT-14:
      //   row 0: Starred header
      //   row 1: page row `work/foo` (starred flat copy, pageIndex=0)
      //   row 2: Pages header
      //   row 3: page row `Inbox` (pageIndex=1)        — alphabetical: I<w
      //   row 4: tree-page row `work` (pageIndex=2)
      // pageIndexToRowIndex = [1, 3, 4]
      // filteredPages.length = 3 (one per visible page row, including
      // the duplicate `work/foo` in Starred).

      // Initial focus: pageIndex 0 = the starred `work/foo` flat copy.
      const initiallyFocused = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(initiallyFocused).not.toBeNull()
      expect(initiallyFocused?.querySelector('.page-browser-item-title')?.textContent).toMatch(
        /work\/foo/,
      )

      // ArrowDown → pageIndex 1 (Inbox flat row inside Pages).
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      const second = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(second?.querySelector('.page-browser-item-title')?.textContent).toBe('Inbox')

      // ArrowDown → pageIndex 2 (the `work` tree-page wrapper). The
      // wrapper carries the focus ring class but no aria-selected (it
      // isn't a listbox option). Verify via the focused-index ring.
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      const treeWrapper = document.querySelector(
        '[data-page-tree-row][data-page-index="2"]',
      ) as HTMLElement | null
      expect(treeWrapper).not.toBeNull()
      // Focus ring class applied via cn() when focusedIndex === pageIndex.
      expect(treeWrapper?.className).toMatch(/ring-2/)

      // End → wrap to last page row (the tree-page `work` row,
      // pageIndex 2). Already there — verify End is a no-op visually.
      fireEvent.keyDown(document, { key: 'End' })
      const endWrapper = document.querySelector(
        '[data-page-tree-row][data-page-index="2"]',
      ) as HTMLElement | null
      expect(endWrapper?.className).toMatch(/ring-2/)
    })

    it('FEAT-14: empty vault renders the EmptyState component (no section chrome)', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)
      // EmptyState renders a translation key that includes "No pages
      // yet" (see `pageBrowser.noPages`).
      await waitFor(() => {
        expect(screen.getByText(/No pages yet/i)).toBeInTheDocument()
      })

      expect(screen.queryByText('Starred')).not.toBeInTheDocument()
      expect(screen.queryByText('Pages')).not.toBeInTheDocument()
      // The viewport's section presence flags reflect "neither".
      const viewport = document.querySelector('[data-slot="scroll-area-viewport"]')
      expect(viewport?.getAttribute('data-has-starred')).toBe('false')
      expect(viewport?.getAttribute('data-has-pages')).toBe('false')
    })

    it('FEAT-14: a11y audit passes on the unified Starred + Pages layout with namespaced rows', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work/project-b' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('project-a')

      // Both sections render under FEAT-14: Starred (the starred-and-
      // namespaced page) and Pages (the namespace tree).
      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()

      await waitFor(async () => {
        const results = await axe(container, {
          rules: {
            // listbox+option pattern intentionally nests interactive
            // chevron / star / delete buttons in each row.
            'nested-interactive': { enabled: false },
            // The `Pages` section renders `PageTreeItem` (button rows)
            // inside the listbox viewport for namespace roots — same
            // pattern as the pre-FEAT-14 tree-mode path.
            'aria-required-children': { enabled: false },
          },
        })
        expect(results).toHaveNoViolations()
      })
    })

    it('star buttons pass a11y audit', async () => {
      localStorage.setItem('starred-pages', JSON.stringify(['P1']))

      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Starred Page' }),
          makePage({ id: 'P2', content: 'Normal Page' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)

      await screen.findByText('Starred Page')

      await waitFor(async () => {
        const results = await axe(container, {
          rules: {
            // listbox+option pattern intentionally nests interactive star/delete buttons
            'nested-interactive': { enabled: false },
          },
        })
        expect(results).toHaveNoViolations()
      })
    })

    // UX-226: ScrollArea replaces bare overflow-y-auto on the page list
    it('page list is wrapped in a ScrollArea viewport (UX-226)', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'A page' })],
        next_cursor: null,
        has_more: false,
      })

      const { container } = render(<PageBrowser />)

      await screen.findByText('A page')

      // The listbox lives on the ScrollArea viewport.
      const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
      expect(viewport).toBeInTheDocument()
      expect(viewport?.getAttribute('role')).toBe('listbox')

      // No bare overflow-y-auto anywhere.
      const anyOverflowY = container.querySelector('.overflow-y-auto')
      expect(anyOverflowY).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // MAINT-14: handleCreateUnder setTimeout must be cleared on unmount so the
  // scheduled focus callback never runs against a detached DOM.
  // ---------------------------------------------------------------------------
  describe('handleCreateUnder setTimeout cleanup (#MAINT-14)', () => {
    it('does not throw if unmounted between handleCreateUnder setTimeout and fire', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work' }),
        ],
        next_cursor: null,
        has_more: false,
      })

      const { unmount } = render(<PageBrowser />)

      // Wait for tree to render
      await screen.findByText('project-a')

      // Find the "Create page under work" button (tree-view adds one per namespace)
      const createUnderBtn = screen.getAllByRole('button', {
        name: /create page under/i,
      })[0]
      expect(createUnderBtn).toBeInTheDocument()

      // Switch to fake timers after DOM is ready. This avoids deadlocks in
      // async waitFor helpers under fake timers.
      vi.useFakeTimers()
      try {
        // Click schedules the focus setTimeout via handleCreateUnder. Use
        // fireEvent.click rather than userEvent since userEvent's async
        // delays hang under fake timers.
        fireEvent.click(createUnderBtn as HTMLElement)

        // Unmount before the 0ms timer fires.
        unmount()

        // Advancing timers after unmount must not throw — the cleanup effect
        // cleared the pending handle, so the focus callback is never invoked.
        expect(() => vi.advanceTimersByTime(10)).not.toThrow()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('UX-198 header outlet migration', () => {
    // The create-page form + search/sort bar used to live inside a
    // `sticky top-0` wrapper div. It's now hoisted to the App-level outlet
    // via <ViewHeader>; the per-view subtree must not contain the stale
    // sticky-positioning classes. The header content still renders
    // (inline fallback when no provider is present) so existing tests
    // querying the create-page form continue to work.
    it('UX-198: no sticky top-0 wrapper div, but header content still renders', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyPage)
      const { container } = render(<PageBrowser />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /New Page/i })).toBeInTheDocument()
      })
      // The old sticky wrapper is gone.
      const sticky = container.querySelector('.sticky.top-0')
      expect(sticky).toBeNull()
      // The new page form is still rendered inline (via ViewHeader fallback).
      expect(screen.getByRole('button', { name: /New Page/i })).toBeInTheDocument()
    })
  })

  // ====================================================================
  // UX-246 — SearchInput clear-button coverage
  // ====================================================================

  describe('SearchInput clear button (UX-246)', () => {
    it('new-page input shows clear button when non-empty and clearing resets name + disables submit', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      const input = screen.getByPlaceholderText('New page name...') as HTMLInputElement
      const submitBtn = screen.getByRole('button', { name: /New Page/i })
      expect(submitBtn).toBeDisabled()
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()

      await user.type(input, 'Draft Page')
      expect(input.value).toBe('Draft Page')
      // Validation wiring still works — submit is enabled now.
      expect(submitBtn).toBeEnabled()

      const clearBtn = screen.getByTestId('search-input-clear')
      expect(clearBtn).toBeInTheDocument()

      await user.click(clearBtn)
      expect(input.value).toBe('')
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()
      // Validation wiring still works — submit is disabled again after clear.
      expect(submitBtn).toBeDisabled()
    })

    it('filter-search input shows clear button when non-empty and clearing restores full list', async () => {
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

      const searchInput = screen.getByPlaceholderText('Search pages...') as HTMLInputElement
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()

      await user.type(searchInput, 'Meeting')
      expect(searchInput.value).toBe('Meeting')
      // Filter applied — non-matching page hidden.
      expect(screen.queryByTitle('Shopping list')).not.toBeInTheDocument()

      const clearBtn = screen.getByTestId('search-input-clear')
      expect(clearBtn).toBeInTheDocument()

      await user.click(clearBtn)
      expect(searchInput.value).toBe('')
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()
      // Filter cleared — both pages are visible again.
      expect(screen.getByText('Meeting notes')).toBeInTheDocument()
      expect(screen.getByText('Shopping list')).toBeInTheDocument()
    })

    it('has no a11y violations when a clear button is visible on the filter input', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Meeting notes' })],
        next_cursor: null,
        has_more: false,
      })

      render(<PageBrowser />)
      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Meet')
      expect(screen.getByTestId('search-input-clear')).toBeInTheDocument()

      // Scope the a11y audit to the SearchInput wrapper containing the
      // visible clear button. The surrounding page-list uses `role="option"`
      // rows containing nested buttons (star / select / delete) which
      // pre-dates this migration and is orthogonal to the SearchInput
      // clear-button affordance under test here. axe cold-load under
      // parallel-worker contention benefits from the waitFor + larger
      // per-test timeout (see AGENTS.md).
      const clearBtn = screen.getByTestId('search-input-clear')
      const searchWrapper = clearBtn.closest('[data-slot="search-input"]') as HTMLElement | null
      expect(searchWrapper).not.toBeNull()

      await waitFor(
        async () => {
          const results = await axe(searchWrapper as HTMLElement)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    }, 10000)
  })
})
