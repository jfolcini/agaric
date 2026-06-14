// @vitest-environment jsdom
// PEND-37: virtualized pagination relies on auto-load timing that behaves
// differently under happy-dom's IntersectionObserver shim. Pin to jsdom
// until the auto-load test is rewritten to use the explicit `<LoadMoreButton>`
// fallback path (which doesn't depend on intersection events).

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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { t } from '@/lib/i18n'

import { emptyPage, makePage } from '../../__tests__/fixtures'
import { usePageBrowserFiltersStore } from '../../stores/pageBrowserFilters'
import { useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { PageBrowser } from '../PageBrowser'

// Capture every `estimateSize` callback passed to `useVirtualizer` so the
// PEND-30 L-5 referential-stability test can assert the function identity
// is unchanged across re-renders that don't change `groupedRows`.
//
// The captured signature is the production one (`(index: number) => number`),
// but the mock invokes it without args throughout this test file (legacy
// zero-arg invocation predates the L-5 change). The `(...args: never[])`
// type lets both calling conventions type-check cleanly without `any`.
type EstimateSizeFn = (...args: never[]) => number
const capturedEstimateSizes: Array<EstimateSizeFn> = []

// PageBrowser pagination UX (2026-05-14) — `vi.mock` is hoisted to
// the top of the file before module-level `const`s, so a mock that
// references a captured spy has to declare the spy via
// `vi.hoisted(…)` (which IS hoisted alongside the mocks).
const { scrollToOffsetMock } = vi.hoisted(() => ({
  scrollToOffsetMock: vi.fn(),
}))

// Mock @tanstack/react-virtual via the shared helper
// (src/__tests__/mocks/react-virtual.ts) to render all items (jsdom has
// zero-height containers). `onEstimateSize` captures each estimator so the
// size assertions can replay it; `scrollToOffset` uses the hoisted spy so the
// scroll-restoration test can assert it fired with the saved offset
// (PageBrowser pagination UX 2026-05-14).
vi.mock('@tanstack/react-virtual', () =>
  mockReactVirtual({
    onEstimateSize: (estimateSize) => capturedEstimateSizes.push(estimateSize as EstimateSizeFn),
    scrollToOffset: scrollToOffsetMock,
  }),
)

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

// #1149 — recent-pages moved from `lib/recent-pages` to the zustand store.
// Override only the snapshot reader the PageBrowser sort/grouping uses;
// keep every other store export real (the full PageBrowser render pulls in
// `useRecentPagesStore`, `QuickAccessBar`, etc.).
vi.mock('@/stores/recent-pages', async (importActual) => {
  const actual = await importActual<typeof import('@/stores/recent-pages')>()
  return { ...actual, getRecentPagesForSpace: vi.fn(() => []) }
})

import { getRecentPagesForSpace } from '@/stores/recent-pages'

const mockedGetRecentPages = vi.mocked(getRecentPagesForSpace)

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

/** Find the trash (delete) button within a page row via its aria-label. */
function findTrashButton(row: HTMLElement): HTMLButtonElement {
  return within(row).getByRole('button', { name: /delete page/i })
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedEstimateSizes.length = 0
  scrollToOffsetMock.mockClear()
  // PageBrowser pagination UX (2026-05-14) — scroll-restoration tests
  // round-trip values through sessionStorage; isolate each test.
  sessionStorage.clear()
  localStorage.removeItem('page-browser-sort')
  localStorage.removeItem('page-browser-density')
  localStorage.removeItem('pageBrowser.densityV1')
  localStorage.removeItem('starred-pages')
  // Compound-filter chips now live in a module-global per-space store; reset it
  // so chips added in one test don't leak into the next.
  usePageBrowserFiltersStore.setState({ filtersBySpace: {}, nextAddId: 0 })
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
    // Legacy rollback path (flag now defaults on; pin off to assert the
    // `list_blocks` IPC shape).
    localStorage.setItem('pageBrowser.densityV1', 'false')
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<PageBrowser />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
        parentId: null,
        blockType: 'page',
        tagId: null,
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
      total_count: null,
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
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    render(<PageBrowser />)

    expect(await screen.findByText('Untitled')).toBeInTheDocument()
  })

  it('uses cursor-based pagination with Load More', async () => {
    // Legacy rollback path — asserts the `list_blocks` cursor shape.
    localStorage.setItem('pageBrowser.densityV1', 'false')
    const page1 = {
      items: [makePage({ id: 'P1', content: 'Page 1' })],
      next_cursor: 'cursor_abc',
      has_more: true,
      total_count: null,
    }
    const page2 = {
      items: [makePage({ id: 'P2', content: 'Page 2' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    render(<PageBrowser />)

    // PageBrowser pagination UX (2026-05-14) — auto-load now fires
    // when the last visible row is within 5 rows of the end. Under
    // the mocked virtualizer (which renders ALL items) that's true
    // from the first paint, so a second `list_blocks` IPC fires
    // immediately without a button click. The existing
    // `<LoadMoreButton>` remains the a11y / no-JS fallback (covered
    // by its own component tests).

    // Should call with the cursor from page 1
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
        parentId: null,
        blockType: 'page',
        tagId: null,
        agenda: null,
        cursor: 'cursor_abc',
        limit: 50,
        spaceId: 'SPACE_TEST',
      })
    })

    // Both pages should be rendered (accumulated). Wait for both inside
    // a single `waitFor` with a generous timeout so a slow CI runner that
    // takes longer than the default 1 s findByText timeout between the
    // second IPC resolving and the accumulator render no longer flakes.
    await waitFor(
      () => {
        expect(screen.queryByText('Page 1')).toBeInTheDocument()
        expect(screen.queryByText('Page 2')).toBeInTheDocument()
      },
      { timeout: 5000 },
    )

    // Load More should disappear after last page
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Load more/i })).not.toBeInTheDocument()
    })
  })

  it('fires onPageSelect callback when a page is clicked', async () => {
    const user = userEvent.setup()
    const onPageSelect = vi.fn()
    const page = {
      items: [makePage({ id: 'P1', content: 'Click me' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    const { container } = render(<PageBrowser />)

    // Wait for the rendered page before auditing — wrapping axe() in
    // waitFor() retries the (slow) audit each tick and reliably blows
    // past the 1s default. Direct findByText is the settle signal.
    await screen.findByText('Accessible page')
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('page item button has focus-visible ring classes', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Focus Page' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<PageBrowser />)

    await screen.findByText('Focus Page')

    const pageRow = screen.getByText('Focus Page').closest('.group') as HTMLElement
    const pageBtn = within(pageRow).getByRole('button', { name: /Focus Page/i })
    expect(pageBtn.className).toContain('focus-ring-visible')
    // UX-237: focus ring must be inset so the inner ScrollArea's
    // `overflow-hidden` does not clip its left/right legs.
    expect(pageBtn).toHaveClass('focus-visible:ring-inset')
  })

  it('UX-11: focused page row highlights with bg only — focus ring lives on the inner button', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Inset Page' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
    // inner <button>'s `focus-ring-visible` to avoid double-stacking.
    expect(focusedRow).toHaveClass('bg-accent/30')
    expect(focusedRow).not.toHaveClass('ring-2')
    expect(focusedRow).not.toHaveClass('ring-ring/50')

    // The inner button still carries the focus-visible ring so keyboard
    // users see exactly one ring when the row is focused.
    const innerBtn = focusedRow
      ? within(focusedRow).getByRole('button', { name: /Inset Page/i })
      : null
    expect(innerBtn).not.toBeNull()
    expect(innerBtn?.className).toContain('focus-ring-visible')
    expect(innerBtn?.className).toContain('focus-visible:ring-inset')
  })

  it('UX-237: star-toggle and delete buttons have ring-inset focus rings', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Inset Buttons Page' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
      total_count: null,
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
      total_count: null,
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
      total_count: null,
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
        total_count: null,
      })

      render(<PageBrowser />)

      expect(await screen.findByText('First page')).toBeInTheDocument()
      expect(screen.getByText('Second page')).toBeInTheDocument()
      // Should use flat list items (row role inside grid; tree-page
      // wrappers are absent when no namespaces exist).
      const grid = screen.getByRole('grid')
      const listItems = within(grid)
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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

    // -----------------------------------------------------------------
    // PEND-29 B-2: alias-resolution stale-fetch guard. When a slow
    // promise resolves AFTER a newer query has been issued, the older
    // result must be discarded so `aliasMatchId` reflects the latest
    // query — not the older in-flight one.
    // -----------------------------------------------------------------

    it('alias resolution discards stale promise resolution (PEND-29 B-2)', async () => {
      // Pin the legacy `list_blocks` path — this test's custom mock only
      // models that IPC; alias behaviour is path-agnostic.
      localStorage.setItem('pageBrowser.densityV1', 'false')
      const user = userEvent.setup()

      // Two pages: `Apple` (P_APPLE) and `Banana` (P_BANANA). The alias
      // resolver below returns the page id matching the query, with an
      // intentional out-of-order resolution: the older `App` query
      // resolves AFTER the newer `Banana` query.
      mockedInvoke.mockReset()
      let resolveApp!: (v: unknown) => void
      let resolveBanana!: (v: unknown) => void
      const aliasCalls: string[] = []
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'list_blocks') {
          return Promise.resolve({
            items: [
              makePage({ id: 'P_APPLE', content: 'Apple' }),
              makePage({ id: 'P_BANANA', content: 'Banana' }),
            ],
            next_cursor: null,
            has_more: false,
            total_count: null,
          })
        }
        if (cmd === 'resolve_page_by_alias') {
          // oxlint-disable-next-line typescript/no-explicit-any -- dynamic IPC args
          const query = (args as any)?.alias as string | undefined
          aliasCalls.push(query ?? '')
          if (query === 'App') {
            return new Promise((resolve) => {
              resolveApp = resolve
            })
          }
          if (query === 'Banana') {
            return new Promise((resolve) => {
              resolveBanana = resolve
            })
          }
          return Promise.resolve(null)
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const searchInput = screen.getByPlaceholderText('Search pages...')

      // Type the first (stale) query.
      await user.type(searchInput, 'App')
      await waitFor(() => {
        expect(aliasCalls.includes('App')).toBe(true)
      })

      // Replace it with a newer query — this fires a second IPC and
      // increments `aliasReqIdRef`, marking the in-flight `App` promise
      // as stale.
      await user.clear(searchInput)
      await user.type(searchInput, 'Banana')
      await waitFor(() => {
        expect(aliasCalls.includes('Banana')).toBe(true)
      })

      // Resolve the newer query first → this is the truthy result and
      // should set `aliasMatchId` to `P_BANANA`.
      await act(async () => {
        resolveBanana(['P_BANANA', 'Banana'])
      })

      // Now resolve the OLDER `App` query with `P_APPLE`. Without the
      // stale-fetch guard this would overwrite `aliasMatchId` and the
      // `App` page would briefly be highlighted in the filtered list,
      // which is impossible because the search input no longer contains
      // `App`. With the guard, the old result is discarded.
      await act(async () => {
        resolveApp(['P_APPLE', 'Apple'])
      })

      // After both promises settle, the live filter still reads
      // `Banana`, so only `Banana` is visible. The stale `Apple` match
      // never leaks through.
      expect(screen.getByTitle('Banana')).toBeInTheDocument()
      expect(screen.queryByText('Apple')).not.toBeInTheDocument()
    })
  })

  describe('sort dropdown', () => {
    it('renders sort dropdown with 7 options', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'A Page' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('A Page')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      expect(sortSelect).toBeInTheDocument()

      const options = within(sortSelect).getAllByRole('option')
      expect(options).toHaveLength(7)
      expect(options.map((o) => o.textContent)).toEqual([
        'Alphabetical',
        'Recent',
        'Created',
        'Recently modified',
        'Most linked',
        'Most content',
        'Default',
      ])
    })

    it('defaults to Alphabetical sort', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'A Page' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
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
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('Apple')

      const listItems = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('Oldest')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'created')

      const listItems = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'recent')

      const listItems = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Accessible page')

      const results = await axe(container)
      expect(results).toHaveNoViolations()
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Initially flat — no Starred header.
      expect(screen.queryByText('Starred')).not.toBeInTheDocument()
      let titles = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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

      // Cherry is now first in the page-only grid.
      titles = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Default sort is alphabetical. Starred set = {Cherry, Banana};
      // Other = {Apple, Durian}. Within each group: alphabetical.
      const titles = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('OldStar')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'created')

      // Starred (newest-first): NewStar, OldStar
      // Other (newest-first):   NewestUnstar, MidUnstar
      const titles = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'recent')

      // Starred = {Apple, Banana} — Apple has a recent visit, Banana does not
      // (alphabetical fallback). Other = {Cherry, Durian} — Cherry recent, Durian not.
      const titles = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Star Banana → moves to top under Starred.
      const bananaRow = screen.getByText('Banana').closest('.group') as HTMLElement
      await user.click(within(bananaRow).getByRole('button', { name: /star page/i }))

      expect(screen.getByText('Starred')).toBeInTheDocument()
      let titles = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
        .map((o) => o.querySelector('.page-browser-item-title')?.textContent)
      expect(titles).toEqual(['Banana', 'Apple', 'Cherry'])

      // Unstar Banana → falls back into Pages, the Starred header
      // disappears (no starred pages remain).
      const bananaRowAgain = screen.getByText('Banana').closest('.group') as HTMLElement
      await user.click(within(bananaRowAgain).getByRole('button', { name: /unstar page/i }))

      expect(screen.queryByText('Starred')).not.toBeInTheDocument()
      titles = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      const starredGroup = container.querySelector(
        '[data-page-section="starred"]',
      ) as HTMLElement | null
      expect(starredGroup).not.toBeNull()
      // Under MAINT-162's grid flip the section header is a row inside
      // the page-list grid (its single gridcell child carries the
      // visible label and the icon).
      expect(starredGroup).toHaveAttribute('role', 'row')
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
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const grid = screen.getByRole('grid')
      expect(grid).toHaveAttribute('aria-label', 'Page list, grouped by starred')
    })

    it('FEAT-12: viewport aria-label stays plain when no starred pages', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const grid = screen.getByRole('grid')
      expect(grid).toHaveAttribute('aria-label', 'Page list')
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
        total_count: null,
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
        total_count: null,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Starred Page')

      // Both group headers must render.
      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()

      const results = await axe(container)
      expect(results).toHaveNoViolations()
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
        total_count: null,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Starred Apple')

      // Filter to only the starred match.
      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Apple')

      // The filter is synchronous on `setState` — by the time
      // user.type resolves the filtered DOM is rendered. axe() runs
      // once; do not wrap in waitFor() (its retry-the-slow-audit loop
      // reliably blows past the 1s default — past flake source).
      const results = await axe(container)
      expect(results).toHaveNoViolations()
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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

      // Starred section gone — both copies refreshed via the
      // `useStarredPages` hook subscription.
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
        total_count: null,
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
        total_count: null,
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
        total_count: null,
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
      // isn't a single selectable cell). Verify via the focused-index ring.
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
        total_count: null,
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('project-a')

      // Both sections render under FEAT-14: Starred (the starred-and-
      // namespaced page) and Pages (the namespace tree).
      expect(screen.getByText('Starred')).toBeInTheDocument()
      expect(screen.getByText('Pages')).toBeInTheDocument()

      // DOM is settled by the synchronous getByText assertions above;
      // wrapping axe() in waitFor() retries the (slow) audit each tick
      // and reliably blows past the 1s default — was a flake source.
      const results = await axe(container)
      expect(results).toHaveNoViolations()
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
        total_count: null,
      })

      const { container } = render(<PageBrowser />)

      await screen.findByText('Starred Page')

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    // UX-226: ScrollArea replaces bare overflow-y-auto on the page list
    it('page list is wrapped in a ScrollArea viewport (UX-226)', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'A page' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      const { container } = render(<PageBrowser />)

      await screen.findByText('A page')

      // The page-list grid lives on the ScrollArea viewport (MAINT-162).
      const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
      expect(viewport).toBeInTheDocument()
      expect(viewport?.getAttribute('role')).toBe('grid')

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
        total_count: null,
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

  // ---------------------------------------------------------------------------
  // UX-331: keyboard navigation exposes aria-activedescendant on the grid so
  // screen readers can track arrow-key focus moves without the inner buttons
  // having to receive DOM focus. Each rendered row also carries a stable id
  // matching the activedescendant value.
  // ---------------------------------------------------------------------------
  describe('UX-331 aria-activedescendant on keyboard nav', () => {
    it('grid container exposes aria-activedescendant matching the focused row id', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // focusedIndex defaults to 0 → the first page row is the active
      // descendant. The row carries `id="page-row-{ULID}"`, and the
      // grid points at it via `aria-activedescendant`.
      const grid = screen.getByRole('grid')
      const focusedRow = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(focusedRow).not.toBeNull()
      expect(focusedRow?.id).toBe('page-row-P1')
      expect(grid).toHaveAttribute('aria-activedescendant', 'page-row-P1')
    })

    it('arrow-down updates aria-activedescendant to the next row id', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
          makePage({ id: 'P3', content: 'Cherry' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const grid = screen.getByRole('grid')
      // Initial state — focus on first page (Apple).
      expect(grid).toHaveAttribute('aria-activedescendant', 'page-row-P1')

      // ArrowDown → focus moves to Banana. The grid's
      // `aria-activedescendant` follows the focused row id.
      await user.keyboard('{ArrowDown}')

      expect(grid).toHaveAttribute('aria-activedescendant', 'page-row-P2')
      const focusedAfter = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(focusedAfter?.id).toBe('page-row-P2')
      // The id referenced by activedescendant exists in the DOM and
      // matches the row currently flagged as selected.
      expect(grid.getAttribute('aria-activedescendant')).toBe(focusedAfter?.id)
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
        total_count: null,
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
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Meet')
      expect(screen.getByTestId('search-input-clear')).toBeInTheDocument()

      // Scope the a11y audit to the SearchInput wrapper containing the
      // visible clear button. The surrounding page-list uses `role="row"`
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

  // ====================================================================
  // PEND-30 L-5 — useVirtualizer.estimateSize must be referentially
  // stable across re-renders that don't change `groupedRows`. TanStack
  // Virtual treats option-identity changes as a re-measure trigger.
  // ====================================================================

  // PageBrowser pagination UX (2026-05-14)
  describe('pagination UX — count chip, auto-load, scroll restoration', () => {
    it('renders "{{count}} pages" count chip when backend supplies total_count', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Page 1' }),
          makePage({ id: 'P2', content: 'Page 2' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: 312,
      })

      render(<PageBrowser />)
      await screen.findByText('Page 1')

      const chip = await screen.findByTestId('page-browser-count')
      expect(chip.textContent).toMatch(/312 pages/)
    })

    it('renders "X of Y matching" when a text query is active (E13: loaded basis)', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
          makePage({ id: 'P3', content: 'Cherry' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: 312,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const search = screen.getByPlaceholderText('Search pages...')
      await user.type(search, 'an')

      // "Banana" matches; Apple/Cherry don't. The chip switches to the
      // "X of Y matching" form. PEND-58e E13 — the text box narrows only
      // the LOADED set (3 pages here), so the denominator is the loaded
      // count (3), NOT the server filtered total (312). Pairing a loaded
      // numerator with a server-total denominator was the basis skew E13
      // fixes.
      const chip = await screen.findByTestId('page-browser-count')
      await waitFor(() => expect(chip.textContent).toMatch(/1 of 3 matching/))
      expect(chip.textContent).not.toMatch(/1 of 312 matching/)
    })

    it('omits the count chip when backend does not supply total_count', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Page 1' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
        // no total_count — older bindings / cursor-only endpoints.
      })

      render(<PageBrowser />)
      await screen.findByText('Page 1')
      expect(screen.queryByTestId('page-browser-count')).not.toBeInTheDocument()
    })

    it('LoadMoreButton receives loadedCount + totalCount and renders progress line', async () => {
      // Page 1 resolves with `has_more: true` + total_count; the
      // second page request never resolves so `hasMore` stays true
      // and the LoadMoreButton (and its progress line) stay mounted.
      // The progress line is only rendered when `hasMore` is true
      // AND both counts are numbers — so this proves the wiring.
      mockedInvoke
        .mockResolvedValueOnce({
          items: [makePage({ id: 'P1', content: 'Page 1' })],
          next_cursor: 'cursor_abc',
          has_more: true,
          total_count: 50,
        })
        // The second page request never resolves — `hasMore` stays true
        // so the LoadMoreButton + progress line remain mounted.
        .mockReturnValueOnce(new Promise(() => undefined))

      render(<PageBrowser />)
      await screen.findByText('Page 1')

      const progress = await screen.findByTestId('load-more-progress')
      // LoadMoreButton template: "Loaded {{loaded}} of {{total}}"
      expect(progress.textContent).toMatch(/1.*50/)
    })

    it('auto-loads the next page when the last visible row is near the end', async () => {
      // The mocked virtualizer renders ALL items; lastVisible.index ===
      // virtualItemCount - 1 every render. So the auto-load effect
      // fires as soon as we mount and there are more pages.
      // Legacy rollback path — asserts the `list_blocks` cursor IPC.
      localStorage.setItem('pageBrowser.densityV1', 'false')
      const page1 = {
        items: [makePage({ id: 'P1', content: 'One' }), makePage({ id: 'P2', content: 'Two' })],
        next_cursor: 'cursor_abc',
        has_more: true,
        total_count: 5,
      }
      const page2 = {
        items: [
          makePage({ id: 'P3', content: 'Three' }),
          makePage({ id: 'P4', content: 'Four' }),
          makePage({ id: 'P5', content: 'Five' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: 5,
      }
      mockedInvoke.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

      render(<PageBrowser />)

      // page 1 fetched on mount; auto-load should fire a second IPC
      // for page 2 without any click on the Load More button.
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith('list_blocks', {
          parentId: null,
          blockType: 'page',
          tagId: null,
          agenda: null,
          cursor: 'cursor_abc',
          limit: 50,
          spaceId: 'SPACE_TEST',
        })
      })

      // Both pages should be rendered (accumulated).
      expect(await screen.findByText('One')).toBeInTheDocument()
      expect(await screen.findByText('Five')).toBeInTheDocument()
    })

    it('restores saved scroll offset on mount once items have hydrated', async () => {
      // Seed sessionStorage as if a prior session saved a position.
      // Value bounded by `virtualizer.getTotalSize()` on read; under
      // the mocked virtualizer that's `count * 44 ~= 132-176` for
      // three pages plus an optional section header, so use 60 to
      // stay safely below the clamp.
      sessionStorage.setItem('pageBrowser:scrollOffset:SPACE_TEST', '60')
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'One' }),
          makePage({ id: 'P2', content: 'Two' }),
          makePage({ id: 'P3', content: 'Three' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: 3,
      })

      render(<PageBrowser />)
      await screen.findByText('One')

      await waitFor(() => {
        expect(scrollToOffsetMock).toHaveBeenCalledWith(60, { align: 'start' })
      })
    })

    it('clamps saved scroll offset to virtualizer.getTotalSize()', async () => {
      // Seed a value larger than any plausible total size; the
      // restoration should clamp it to `getTotalSize()` so the
      // virtualizer doesn't scroll into empty space when the list
      // shrank between sessions.
      sessionStorage.setItem('pageBrowser:scrollOffset:SPACE_TEST', '99999')
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Only' })],
        next_cursor: null,
        has_more: false,
        total_count: 1,
      })

      render(<PageBrowser />)
      await screen.findByText('Only')

      await waitFor(() => expect(scrollToOffsetMock).toHaveBeenCalled())
      const firstCall = scrollToOffsetMock.mock.calls[0]
      if (firstCall === undefined) throw new Error('scrollToOffset never called')
      const [offset, opts] = firstCall
      expect(offset).toBeLessThan(99999)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(opts).toEqual({ align: 'start' })
    })

    it('does not restore scroll when sessionStorage is empty', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'One' })],
        next_cursor: null,
        has_more: false,
        total_count: 1,
      })

      render(<PageBrowser />)
      await screen.findByText('One')

      // Wait a tick for restore effect to run if it was going to.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(scrollToOffsetMock).not.toHaveBeenCalled()
    })

    it('clears saved scroll offset when the filter changes', async () => {
      // Seed; mount with a filtered result so the user types, and the
      // saved offset should be wiped (the saved position is
      // meaningless against the post-filter view).
      sessionStorage.setItem('pageBrowser:scrollOffset:SPACE_TEST', '480')
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: 2,
      })

      const user = userEvent.setup()
      render(<PageBrowser />)
      await screen.findByText('Apple')
      // Restoration runs first; assert it happened, then clear the
      // mock so the next event triggers a fresh state.
      await waitFor(() => expect(scrollToOffsetMock).toHaveBeenCalled())

      const search = screen.getByPlaceholderText('Search pages...')
      await user.type(search, 'app')

      // Saved offset should have been removed.
      await waitFor(() => {
        expect(sessionStorage.getItem('pageBrowser:scrollOffset:SPACE_TEST')).toBeNull()
      })
    })

    it('uses a per-space sessionStorage key', async () => {
      // Seed a value for SPACE_OTHER — it should NOT be applied to
      // SPACE_TEST. Cross-space contamination is the bug this guards.
      sessionStorage.setItem('pageBrowser:scrollOffset:SPACE_OTHER', '999')
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'One' })],
        next_cursor: null,
        has_more: false,
        total_count: 1,
      })

      render(<PageBrowser />)
      await screen.findByText('One')
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
      // No call: the SPACE_OTHER value must not leak into SPACE_TEST.
      expect(scrollToOffsetMock).not.toHaveBeenCalled()
    })
  })

  describe('PEND-30 L-5 estimateSize referential stability', () => {
    it('estimateSize identity is preserved across re-renders that do not change groupedRows', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Snapshot the estimateSize ref after the initial render. Multiple
      // captures may exist due to the mount-time settle (effects fire,
      // useStarredPages reads localStorage, etc.) — pick the latest as
      // the post-stabilisation reference.
      expect(capturedEstimateSizes.length).toBeGreaterThan(0)
      const initialEstimateSize = capturedEstimateSizes[capturedEstimateSizes.length - 1]

      // Trigger a re-render that changes only the `newPageName` state —
      // `groupedRows`, `pages`, `filterText`, sorting, and starred set
      // are all untouched, so the memoized `estimateSize` returned by
      // `useCallback([groupedRows])` must be the same reference.
      const newPageInput = screen.getByPlaceholderText('New page name...')
      const beforeCount = capturedEstimateSizes.length
      await user.type(newPageInput, 'Draft')
      // Wait for at least one re-render to register a new captured ref.
      await waitFor(() => {
        expect(capturedEstimateSizes.length).toBeGreaterThan(beforeCount)
      })

      // Every captured estimateSize after the initial stabilisation
      // should be the same reference — `groupedRows` did not change.
      for (let i = beforeCount; i < capturedEstimateSizes.length; i++) {
        expect(capturedEstimateSizes[i]).toBe(initialEstimateSize)
      }
    })
  })

  // ── PEND-56 Phase 3 — density-v1 flag-on path ─────────────────────
  //
  // The localStorage flag `pageBrowser.densityV1` swings the queryFn
  // from `listBlocks` to `listPagesWithMetadata` and routes the leaf
  // rows through `<DensityRow>`. These tests pin the flag ON in
  // `beforeEach`, clear it in `afterEach`, and verify the wiring.
  describe('PEND-56 — density-v1 flag', () => {
    beforeEach(() => {
      localStorage.setItem('pageBrowser.densityV1', 'true')
    })
    afterEach(() => {
      localStorage.removeItem('pageBrowser.densityV1')
      localStorage.removeItem('page-browser-density')
    })

    /** Shape that mirrors what `list_pages_with_metadata` returns. */
    function makeMetaPage(overrides: {
      id: string
      content: string | null
      lastModifiedAt?: number | null
      inboundLinkCount?: number
      childBlockCount?: number
      flags?: { hasTags: boolean; hasTodo: boolean; hasScheduled: boolean; hasDue: boolean }
    }) {
      return {
        id: overrides.id,
        blockType: 'page',
        content: overrides.content,
        parentId: null,
        position: null,
        deletedAt: null,
        todoState: null,
        priority: null,
        dueDate: null,
        scheduledDate: null,
        pageId: overrides.id,
        lastModifiedAt: overrides.lastModifiedAt ?? null,
        inboundLinkCount: overrides.inboundLinkCount ?? 0,
        childBlockCount: overrides.childBlockCount ?? 0,
        flags: overrides.flags ?? {
          hasTags: false,
          hasTodo: false,
          hasScheduled: false,
          hasDue: false,
        },
      }
    }

    it('calls list_pages_with_metadata (and not list_blocks) on mount when the flag is on', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const metadataCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'list_pages_with_metadata',
      )
      expect(metadataCalls.length).toBeGreaterThan(0)

      const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
      expect(listBlocksCalls).toHaveLength(0)
    })

    it('renders leaf rows via <DensityRow> at the default `regular` density', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      const densityRows = container.querySelectorAll('[data-page-item][data-density]')
      expect(densityRows.length).toBeGreaterThan(0)
      expect(densityRows[0]?.getAttribute('data-density')).toBe('regular')
    })

    it('switching density via the header Select updates every leaf row', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [
              makeMetaPage({ id: 'P1', content: 'Apple' }),
              makeMetaPage({ id: 'P2', content: 'Banana' }),
            ],
            next_cursor: null,
            has_more: false,
            total_count: 2,
          })
        }
        return Promise.resolve(undefined)
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      const densitySelect = screen.getByRole('combobox', { name: /row density/i })
      await user.selectOptions(densitySelect, 'compact')

      await waitFor(() => {
        const rows = container.querySelectorAll('[data-page-item][data-density]')
        expect(rows.length).toBeGreaterThan(0)
        for (const r of rows) {
          expect(r.getAttribute('data-density')).toBe('compact')
        }
      })
    })

    it('density persists across remount via localStorage', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      const first = render(<PageBrowser />)
      await screen.findByText('Apple')

      const densitySelect = screen.getByRole('combobox', { name: /row density/i })
      await user.selectOptions(densitySelect, 'expanded')

      // Wait for the row to pick up the new density.
      await waitFor(() => {
        const row = first.container.querySelector('[data-page-item][data-density]')
        expect(row?.getAttribute('data-density')).toBe('expanded')
      })

      // Sanity: the preference was written to localStorage.
      expect(localStorage.getItem('page-browser-density')).toBe('expanded')

      first.unmount()

      const second = render(<PageBrowser />)
      await screen.findByText('Apple')

      const row = second.container.querySelector('[data-page-item][data-density]')
      expect(row?.getAttribute('data-density')).toBe('expanded')
    })

    it('density toggle invalidates the saved scroll offset (sessionStorage.removeItem fires)', async () => {
      const user = userEvent.setup()
      // Seed a stored offset for the active space so the restore effect
      // fires and `restoredRef.current` flips to `true` BEFORE the
      // density change — only then does the clear effect fire.
      sessionStorage.setItem('pageBrowser:scrollOffset:SPACE_TEST', '60')

      const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem')

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [
              makeMetaPage({ id: 'P1', content: 'Apple' }),
              makeMetaPage({ id: 'P2', content: 'Banana' }),
              makeMetaPage({ id: 'P3', content: 'Cherry' }),
            ],
            next_cursor: null,
            has_more: false,
            total_count: 3,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Wait for restoration to finish before flipping density (else
      // the clear effect short-circuits on `restoredRef === false`).
      await waitFor(() => expect(scrollToOffsetMock).toHaveBeenCalled())

      removeItemSpy.mockClear()

      const densitySelect = screen.getByRole('combobox', { name: /row density/i })
      await user.selectOptions(densitySelect, 'compact')

      await waitFor(() => {
        const calls = removeItemSpy.mock.calls.map((c) => c[0])
        expect(calls).toContain('pageBrowser:scrollOffset:SPACE_TEST')
      })

      removeItemSpy.mockRestore()
    })

    it('selecting `most-linked` sort passes `sort: most-linked` to the IPC', async () => {
      const user = userEvent.setup()
      const calls: Array<Record<string, unknown>> = []
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          calls.push(args as Record<string, unknown>)
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple', inboundLinkCount: 3 })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'most-linked')

      await waitFor(() => {
        const seenSorts = calls.map((c) => (c['filter'] as Record<string, unknown>)?.['sort'])
        expect(seenSorts).toContain('most-linked')
      })
    })

    it('selecting `alphabetical` sort maps to the `default` wire enum (frontend-only sort)', async () => {
      const user = userEvent.setup()
      const calls: Array<Record<string, unknown>> = []
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          calls.push(args as Record<string, unknown>)
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      // Seed a non-alphabetical default so we can observe the change
      // back to `alphabetical` triggering a fresh IPC call.
      localStorage.setItem('page-browser-sort', 'most-linked')

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'alphabetical')

      await waitFor(() => {
        // The most recent IPC call should carry `sort: default` because
        // `alphabetical` is the frontend-only re-sort mode.
        const last = calls.at(-1)
        expect(last).toBeDefined()
        const filter = last?.['filter'] as Record<string, unknown> | undefined
        expect(filter?.['sort']).toBe('default')
      })

      localStorage.removeItem('page-browser-sort')
    })

    it('selecting `recently-modified` sort passes `sort: recently-modified` to the IPC', async () => {
      const user = userEvent.setup()
      const calls: Array<Record<string, unknown>> = []
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          calls.push(args as Record<string, unknown>)
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'recently-modified')

      await waitFor(() => {
        const seenSorts = calls.map((c) => (c['filter'] as Record<string, unknown>)?.['sort'])
        expect(seenSorts).toContain('recently-modified')
      })
    })

    it('RequiresRefresh: cursor recovery retries once with no cursor', async () => {
      // First load: returns page 1 with a next_cursor so the auto-load
      // fires a second IPC. The first cursor-bearing call rejects with
      // an AppError tagged `RequiresRefresh:` (v2 cursor mismatch); the
      // recovery wrapper retries once with `cursor: null`. The retry
      // resolves successfully.
      const cursoredCalls: Array<Record<string, unknown>> = []
      let cursoredCallCount = 0
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          const a = (args ?? {}) as Record<string, unknown>
          if (a['cursor'] == null) {
            // Either the initial load or the recovery retry — both
            // resolve normally. Distinguish by whether we've already
            // served a cursor-bearing call.
            if (cursoredCallCount === 0) {
              return Promise.resolve({
                items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
                next_cursor: 'STALE_V1_CURSOR',
                has_more: true,
                total_count: 2,
              })
            }
            // Recovery retry — return the next page-from-the-top.
            cursoredCalls.push(a)
            return Promise.resolve({
              items: [makeMetaPage({ id: 'P2', content: 'Banana' })],
              next_cursor: null,
              has_more: false,
              total_count: 2,
            })
          }
          // Cursor-bearing call → reject with the v2 mismatch error
          // the first time, succeed the second.
          cursoredCallCount += 1
          if (cursoredCallCount === 1) {
            return Promise.reject({
              kind: 'validation',
              message: 'RequiresRefresh: cursor sort mismatch',
            })
          }
          cursoredCalls.push(a)
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P2', content: 'Banana' })],
            next_cursor: null,
            has_more: false,
            total_count: 2,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)

      // Both batches eventually surface despite the v2 cursor rejection.
      await screen.findByText('Apple')
      await waitFor(() => {
        expect(screen.queryByText('Banana')).toBeInTheDocument()
      })

      // The cursor-bearing call rejected once → recovery fired a
      // cursorless retry. Confirm the rejection was observed by counting
      // the cursor-bearing attempts.
      expect(cursoredCallCount).toBeGreaterThanOrEqual(1)
    })

    it('a11y audit passes at every density', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [
              makeMetaPage({ id: 'P1', content: 'Accessible page' }),
              makeMetaPage({ id: 'P2', content: 'Another page' }),
            ],
            next_cursor: null,
            has_more: false,
            total_count: 2,
          })
        }
        return Promise.resolve(undefined)
      })

      const user = userEvent.setup()
      const { container } = render(<PageBrowser />)
      await screen.findByText('Accessible page')

      // Audit at the default `regular` density first.
      let results = await axe(container)
      expect(results).toHaveNoViolations()

      // Then `compact` and `expanded`.
      const densitySelect = screen.getByRole('combobox', { name: /row density/i })
      await user.selectOptions(densitySelect, 'compact')
      await waitFor(() => {
        const r = container.querySelector('[data-page-item][data-density]')
        expect(r?.getAttribute('data-density')).toBe('compact')
      })
      results = await axe(container)
      expect(results).toHaveNoViolations()

      await user.selectOptions(densitySelect, 'expanded')
      await waitFor(() => {
        const r = container.querySelector('[data-page-item][data-density]')
        expect(r?.getAttribute('data-density')).toBe('expanded')
      })
      results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── PEND-56 Phase 3 — sort comparator vs metadata ─────────────────
  //
  // The frontend `sortPages` comparator re-sorts the loaded page when
  // the chosen sort is one of the metadata-aware modes. These tests
  // hand-craft rows with known counts/timestamps and confirm the
  // displayed order matches the comparator (alphabetical tiebreaker).
  describe('PEND-56 — sort comparator vs metadata', () => {
    beforeEach(() => {
      localStorage.setItem('pageBrowser.densityV1', 'true')
    })
    afterEach(() => {
      localStorage.removeItem('pageBrowser.densityV1')
      localStorage.removeItem('page-browser-sort')
    })

    function makeMetaPage(overrides: {
      id: string
      content: string | null
      lastModifiedAt?: number | null
      inboundLinkCount?: number
      childBlockCount?: number
    }) {
      return {
        id: overrides.id,
        blockType: 'page',
        content: overrides.content,
        parentId: null,
        position: null,
        deletedAt: null,
        todoState: null,
        priority: null,
        dueDate: null,
        scheduledDate: null,
        pageId: overrides.id,
        lastModifiedAt: overrides.lastModifiedAt ?? null,
        inboundLinkCount: overrides.inboundLinkCount ?? 0,
        childBlockCount: overrides.childBlockCount ?? 0,
        flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
      }
    }

    function renderedTitles(): Array<string | null | undefined> {
      return within(screen.getByRole('grid'))
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
        .map((r) => r.querySelector('.page-browser-item-title')?.textContent)
    }

    it('most-linked orders by inboundLinkCount DESC with alphabetical tiebreaker', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [
              // Two-tie at link count 1 → alphabetical tiebreaker (Apple, Cherry).
              makeMetaPage({ id: 'P1', content: 'Apple', inboundLinkCount: 1 }),
              makeMetaPage({ id: 'P2', content: 'Banana', inboundLinkCount: 5 }),
              makeMetaPage({ id: 'P3', content: 'Cherry', inboundLinkCount: 1 }),
              makeMetaPage({ id: 'P4', content: 'Date', inboundLinkCount: 3 }),
            ],
            next_cursor: null,
            has_more: false,
            total_count: 4,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'most-linked')

      await waitFor(() => {
        expect(renderedTitles()).toEqual(['Banana', 'Date', 'Apple', 'Cherry'])
      })
    })

    it('most-content orders by childBlockCount DESC with alphabetical tiebreaker', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [
              makeMetaPage({ id: 'P1', content: 'Apple', childBlockCount: 2 }),
              makeMetaPage({ id: 'P2', content: 'Banana', childBlockCount: 10 }),
              makeMetaPage({ id: 'P3', content: 'Cherry', childBlockCount: 2 }),
              makeMetaPage({ id: 'P4', content: 'Date', childBlockCount: 7 }),
            ],
            next_cursor: null,
            has_more: false,
            total_count: 4,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'most-content')

      await waitFor(() => {
        expect(renderedTitles()).toEqual(['Banana', 'Date', 'Apple', 'Cherry'])
      })
    })

    it('recently-modified orders by lastModifiedAt DESC with alphabetical tiebreaker', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [
              makeMetaPage({
                id: 'P1',
                content: 'Apple',
                lastModifiedAt: 1767225600000,
              }),
              makeMetaPage({
                id: 'P2',
                content: 'Banana',
                lastModifiedAt: 1772323200000,
              }),
              // Same timestamp as Apple → alphabetical tiebreaker.
              makeMetaPage({
                id: 'P3',
                content: 'Cherry',
                lastModifiedAt: 1767225600000,
              }),
              makeMetaPage({
                id: 'P4',
                content: 'Date',
                lastModifiedAt: 1769904000000,
              }),
            ],
            next_cursor: null,
            has_more: false,
            total_count: 4,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'recently-modified')

      await waitFor(() => {
        expect(renderedTitles()).toEqual(['Banana', 'Date', 'Apple', 'Cherry'])
      })
    })
  })

  // ── PEND-58 Phase 3 — compound filters ────────────────────────────
  //
  // With the densityV1 flag on, the chip-row applies server-side
  // filters by threading a `filters` array into the metadata IPC.
  // These tests drive the real Add-Filter popover and assert the IPC
  // receives the chosen primitive, then that removing it clears it.
  describe('PEND-58 — compound filters', () => {
    beforeEach(() => {
      localStorage.setItem('pageBrowser.densityV1', 'true')
    })
    afterEach(() => {
      localStorage.removeItem('pageBrowser.densityV1')
    })

    function metaPage(id: string, content: string) {
      return {
        id,
        blockType: 'page',
        content,
        parentId: null,
        position: null,
        deletedAt: null,
        todoState: null,
        priority: null,
        dueDate: null,
        scheduledDate: null,
        pageId: id,
        lastModifiedAt: null,
        inboundLinkCount: 0,
        childBlockCount: 0,
        flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
      }
    }

    /** Pull the `filter.filters` array from the most-recent metadata call. */
    function lastMetadataFilters(): unknown[] {
      const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_pages_with_metadata')
      const last = calls.at(-1)
      const arg = last?.[1] as { filter?: { filters?: unknown[] } } | undefined
      return arg?.filter?.filters ?? []
    }

    it('threads a Stub chip into the metadata IPC and clears it on remove', async () => {
      const user = userEvent.setup()
      // P2-D — vary the mock return on the `filters` arg so this exercises
      // one real narrowing case at the React level (not just IPC wiring):
      // unfiltered returns both pages; with a Stub chip the server reply
      // narrows to the stub page only. (The full filter→SQL semantics are
      // covered backend-side in the Rust suite.)
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          const filters =
            (args as { filter?: { filters?: Array<{ type?: string }> } } | undefined)?.filter
              ?.filters ?? []
          const hasStub = filters.some((f) => f.type === 'Stub')
          const items = hasStub
            ? [metaPage('P1', 'Apple')]
            : [metaPage('P1', 'Apple'), metaPage('P2', 'Banana')]
          return Promise.resolve({
            items,
            next_cursor: null,
            has_more: false,
            total_count: items.length,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      // Unfiltered: both pages are present.
      await screen.findByText('Apple')
      expect(screen.getByText('Banana')).toBeInTheDocument()

      // Open the Add-Filter popover and pick the Pages-only "Stub" facet.
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))

      // The IPC should now be called with a Stub primitive.
      await waitFor(() => {
        expect(lastMetadataFilters()).toContainEqual({ type: 'Stub' })
      })

      // The varied mock narrows the result: Banana drops, Apple stays.
      await waitFor(() => {
        expect(screen.queryByText('Banana')).not.toBeInTheDocument()
      })
      expect(screen.getByText('Apple')).toBeInTheDocument()

      // A chip renders for the active filter.
      expect(screen.getByRole('group', { name: 'Filter: Stub' })).toBeInTheDocument()

      // Remove the chip → the next IPC call carries no filters and the
      // narrowed-out page returns.
      await user.click(screen.getByRole('button', { name: 'Remove filter Stub' }))
      await waitFor(() => {
        expect(lastMetadataFilters()).toEqual([])
      })
      await screen.findByText('Banana')
    })

    it('renders the no-match state (not the empty-space state) when a chip narrows to zero', async () => {
      // P0-B — with an empty text box but an active chip, a zero-row
      // server reply must render the "No matching pages" no-match state,
      // NOT the "No pages yet / Create your first page" empty-space state
      // (which falsely tells a user with a full graph it's empty).
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          const filters =
            (args as { filter?: { filters?: Array<{ type?: string }> } } | undefined)?.filter
              ?.filters ?? []
          // Unfiltered shows one page so the chip-row (and Add-filter
          // button) are reachable; the Stub chip narrows to zero rows.
          const items = filters.length > 0 ? [] : [metaPage('P1', 'Apple')]
          return Promise.resolve({
            items,
            next_cursor: null,
            has_more: false,
            total_count: items.length,
          })
        }
        return Promise.resolve(undefined)
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      // Add a Stub chip → server returns zero rows.
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))

      // The no-match message renders.
      await screen.findByText(t('pageBrowser.noMatches'))

      // The empty-space state is NOT shown.
      expect(screen.queryByText(t('pageBrowser.noPages'))).not.toBeInTheDocument()
      expect(screen.queryByText(t('pageBrowser.createFirst'))).not.toBeInTheDocument()

      // The remove-filter control is present so the user can widen again.
      expect(screen.getByRole('button', { name: 'Remove filter Stub' })).toBeInTheDocument()

      // a11y audit of the chip-only zero-result view.
      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    it('announces filter add and remove in a polite live region (P1-F1)', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          const filters =
            (args as { filter?: { filters?: Array<{ type?: string }> } } | undefined)?.filter
              ?.filters ?? []
          const hasStub = filters.some((f) => f.type === 'Stub')
          const items = hasStub
            ? [metaPage('P1', 'Apple')]
            : [metaPage('P1', 'Apple'), metaPage('P2', 'Banana')]
          return Promise.resolve({
            items,
            next_cursor: null,
            has_more: false,
            total_count: items.length,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const liveRegion = screen.getByTestId('filter-announcement')
      // Nothing announced before any chip interaction.
      expect(liveRegion).toHaveTextContent('')

      // Add a Stub chip → "Filter added: Stub. 1 result."
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(
          t('pageBrowser.filter.announceAdded', { label: 'Stub' }),
        )
      })
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(t('pageBrowser.filter.announceResults', { count: 1 }))
      })

      // Remove the chip → "Filter removed: Stub. 2 results."
      await user.click(screen.getByRole('button', { name: 'Remove filter Stub' }))
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(
          t('pageBrowser.filter.announceRemoved', { label: 'Stub' }),
        )
      })
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(t('pageBrowser.filter.announceResults', { count: 2 }))
      })
    })

    it('does not render the filter row on the legacy (flag-off) path', async () => {
      // The flag is now opt-OUT (default on); set it explicitly to
      // 'false' to exercise the legacy `listBlocks` rollback path.
      localStorage.setItem('pageBrowser.densityV1', 'false')
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_blocks') {
          return Promise.resolve({
            items: [
              {
                id: 'P1',
                block_type: 'page',
                content: 'Apple',
                parent_id: null,
                position: null,
                deleted_at: null,
                todo_state: null,
                priority: null,
                due_date: null,
                scheduled_date: null,
                page_id: 'P1',
              },
            ],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')
      expect(screen.queryByRole('button', { name: 'Add filter' })).not.toBeInTheDocument()
    })
  })

  // ── PEND-58d — frontend container hardening ─────────────────────────
  //
  // Covers the orchestrator-level fixes: load-more grid a11y (D9),
  // optimistic-create vs active filters (D10), count-chip basis
  // integration (D11), duplicate-chip dedupe (D22), and the
  // cursor-recovery retry-also-fails path (T-F2 / withCursorRecovery).
  describe('PEND-58d — frontend container hardening', () => {
    beforeEach(() => {
      localStorage.setItem('pageBrowser.densityV1', 'true')
    })
    afterEach(() => {
      localStorage.removeItem('pageBrowser.densityV1')
    })

    function metaPage(id: string, content: string) {
      return {
        id,
        blockType: 'page',
        content,
        parentId: null,
        position: null,
        deletedAt: null,
        todoState: null,
        priority: null,
        dueDate: null,
        scheduledDate: null,
        pageId: id,
        lastModifiedAt: null,
        inboundLinkCount: 0,
        childBlockCount: 0,
        flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
      }
    }

    // ── D9 — LoadMoreButton is a valid grid child + axe in hasMore ──────
    //
    // The mocked virtualizer renders all items, so the auto-load effect
    // fires a cursor page on mount. Page 1 resolves with `has_more: true`;
    // the cursor page never resolves, so `hasMore` stays true and the
    // load-more footer remains mounted for the assertions.
    it('D9: wraps the load-more button in a role=row > role=gridcell footer', async () => {
      mockedInvoke
        .mockImplementationOnce((cmd: string) => {
          if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
          if (cmd === 'list_pages_with_metadata') {
            return Promise.resolve({
              items: [metaPage('P1', 'Apple')],
              next_cursor: 'cursor_abc',
              has_more: true,
              total_count: 50,
            })
          }
          return Promise.resolve(undefined)
        })
        .mockImplementation((cmd: string) => {
          if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
          // Cursor page never resolves → hasMore stays true.
          if (cmd === 'list_pages_with_metadata') return new Promise(() => undefined)
          return Promise.resolve(undefined)
        })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      // The footer row holding the load-more control must be a valid grid
      // descendant: gridcell inside row inside the grid viewport. Target
      // the load-more footer row by its class (page rows are also grid
      // rows/cells, so a bare `[role="gridcell"]` would match those).
      const footerRow = await waitFor(() => {
        const r = container.querySelector('.page-browser-load-more-row')
        if (r == null) throw new Error('no load-more footer row yet')
        return r
      })
      expect(footerRow).toHaveAttribute('role', 'row')
      const gridcell = footerRow.querySelector('[role="gridcell"]')
      expect(gridcell).not.toBeNull()
      // The load-more control lives inside that gridcell.
      const loadMoreBtn = within(gridcell as HTMLElement).getByRole('button')
      expect(loadMoreBtn).toBeInTheDocument()
      expect(gridcell?.querySelector('.page-browser-load-more')).not.toBeNull()
      // The footer row is a descendant of the grid viewport.
      expect(footerRow.closest('[role="grid"]')).not.toBeNull()
    })

    it('D9: no axe violations in the hasMore (load-more visible) state', async () => {
      mockedInvoke
        .mockImplementationOnce((cmd: string) => {
          if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
          if (cmd === 'list_pages_with_metadata') {
            return Promise.resolve({
              items: [metaPage('P1', 'Apple')],
              next_cursor: 'cursor_abc',
              has_more: true,
              total_count: 50,
            })
          }
          return Promise.resolve(undefined)
        })
        .mockImplementation((cmd: string) => {
          if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
          if (cmd === 'list_pages_with_metadata') return new Promise(() => undefined)
          return Promise.resolve(undefined)
        })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')
      // Wait for the load-more footer to mount.
      await waitFor(() => {
        expect(container.querySelector('[role="gridcell"]')).not.toBeNull()
      })

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })

    // ── D10 — optimistic create respects active filters ────────────────
    it('D10: create with active chips refetches (reload) instead of prepending', async () => {
      const user = userEvent.setup()
      // Track metadata calls; the create with a chip active must trigger a
      // fresh page-1 metadata fetch (reload) rather than an optimistic
      // prepend.
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'create_page_in_space') return Promise.resolve('P_NEW')
        if (cmd === 'list_pages_with_metadata') {
          const filters =
            (args as { filter?: { filters?: Array<{ type?: string }> } } | undefined)?.filter
              ?.filters ?? []
          const hasStub = filters.some((f) => f.type === 'Stub')
          // With the Stub chip, the server reply never includes the new
          // page (it doesn't match), so an optimistic prepend would be
          // wrong — only a reload (which re-queries the server) is correct.
          return Promise.resolve({
            items: hasStub ? [metaPage('P1', 'Apple')] : [metaPage('P1', 'Apple')],
            next_cursor: null,
            has_more: false,
            total_count: hasStub ? 1 : 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Activate a Stub chip.
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))
      await waitFor(() => {
        expect(screen.getByRole('group', { name: 'Filter: Stub' })).toBeInTheDocument()
      })

      const metadataCallsBefore = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'list_pages_with_metadata',
      ).length

      // Create a page while the chip is active.
      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'Brand New Page')
      await user.click(screen.getByRole('button', { name: /New Page/i }))

      // The create IPC fired.
      await waitFor(() => {
        expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'create_page_in_space')).toBe(true)
      })

      // A fresh metadata fetch (reload) must have fired after create.
      await waitFor(() => {
        const after = mockedInvoke.mock.calls.filter(
          ([cmd]) => cmd === 'list_pages_with_metadata',
        ).length
        expect(after).toBeGreaterThan(metadataCallsBefore)
      })

      // The optimistic-but-unmatched row must NOT appear (the server reply
      // for the Stub query doesn't include it).
      expect(screen.queryByText('Brand New Page')).not.toBeInTheDocument()
    })

    it('D10: create with no chips active still prepends optimistically (no extra fetch)', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'create_page_in_space') return Promise.resolve('P_NEW')
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [metaPage('P1', 'Apple')],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const metadataCallsBefore = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'list_pages_with_metadata',
      ).length

      const input = screen.getByPlaceholderText('New page name...')
      await user.type(input, 'Fresh Page')
      await user.click(screen.getByRole('button', { name: /New Page/i }))

      // The optimistic row appears immediately.
      expect(await screen.findByText('Fresh Page')).toBeInTheDocument()

      // No reload fetch was triggered by the create (the fast path).
      const metadataCallsAfter = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'list_pages_with_metadata',
      ).length
      expect(metadataCallsAfter).toBe(metadataCallsBefore)
    })

    // ── D11 — count chip uses the chip-only "matching" basis ───────────
    it('D11: count chip shows the "matching pages" form when a chip is active without text', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          const filters =
            (args as { filter?: { filters?: Array<{ type?: string }> } } | undefined)?.filter
              ?.filters ?? []
          const hasStub = filters.some((f) => f.type === 'Stub')
          const items = hasStub
            ? [metaPage('P1', 'Apple')]
            : [metaPage('P1', 'Apple'), metaPage('P2', 'Banana')]
          return Promise.resolve({
            items,
            next_cursor: null,
            has_more: false,
            // Server-side filtered total: 1 with the Stub chip, 2 without.
            total_count: hasStub ? 1 : 2,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Unfiltered → "2 pages" (countAll).
      const chip = await screen.findByTestId('page-browser-count')
      expect(chip).toHaveTextContent(t('pageBrowser.countAll', { count: 2 }))

      // Add a Stub chip (no text) → "1 matching page" (countMatching),
      // NOT "1 of 2 matching".
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))

      await waitFor(() => {
        expect(screen.getByTestId('page-browser-count')).toHaveTextContent(
          t('pageBrowser.countMatching', { count: 1 }),
        )
      })
      expect(screen.getByTestId('page-browser-count')).not.toHaveTextContent(
        t('pageBrowser.countFiltered', { loaded: 1, total: 2 }),
      )
    })

    // ── D22 — duplicate chips are deduped on add ───────────────────────
    it('D22: adding the same filter twice does not duplicate the chip', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [metaPage('P1', 'Apple')],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Add a Stub chip once.
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))
      await waitFor(() => {
        expect(screen.getByRole('group', { name: 'Filter: Stub' })).toBeInTheDocument()
      })

      // Add the identical Stub chip again — it must be a no-op. Scope the
      // option click to the Add-Filter dialog so it isn't confused with
      // the existing "Stub" chip pill that now also reads "Stub".
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      const dialog = await screen.findByRole('dialog', {
        name: t('pageBrowser.filter.addFilterDialogLabel'),
      })
      await user.click(within(dialog).getByText('Stub'))

      // Exactly one Stub chip remains.
      await waitFor(() => {
        expect(screen.getAllByRole('group', { name: 'Filter: Stub' })).toHaveLength(1)
      })
      // And only one remove-control exists for it.
      expect(screen.getAllByRole('button', { name: 'Remove filter Stub' })).toHaveLength(1)
    })

    // ── T-F2 — withCursorRecovery: retry-also-fails propagates error ───
    it('T-F2: when the cursorless retry also fails, the original error surfaces (load-failed toast)', async () => {
      // Page 1 resolves with a next_cursor so auto-load fires a cursor
      // page. The cursor-bearing call rejects with `RequiresRefresh:`, so
      // `withCursorRecovery` retries once with no cursor — and THAT retry
      // also rejects. The error must propagate to `usePaginatedQuery`'s
      // onError, firing the load-failed toast.
      let cursoredAttempts = 0
      let cursorlessRetries = 0
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          const a = (args ?? {}) as Record<string, unknown>
          const cursor =
            (a['filter'] as Record<string, unknown> | undefined)?.['cursor'] ?? a['cursor']
          if (cursor == null) {
            // Could be the initial load or the cursorless recovery retry.
            if (cursoredAttempts === 0) {
              // Initial load — succeeds with a cursor so auto-load fires.
              return Promise.resolve({
                items: [metaPage('P1', 'Apple')],
                next_cursor: 'STALE_CURSOR',
                has_more: true,
                total_count: 2,
              })
            }
            // Recovery retry (cursorless) — also fails.
            cursorlessRetries += 1
            return Promise.reject({
              kind: 'validation',
              message: 'Boom: retry failed too',
            })
          }
          // Cursor-bearing call → reject with the v2 mismatch so recovery
          // kicks in.
          cursoredAttempts += 1
          return Promise.reject({
            kind: 'validation',
            message: 'RequiresRefresh: cursor sort mismatch',
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // The cursor-bearing call rejected → recovery retried cursorless →
      // that retry also rejected → the load-failed toast fired.
      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to load pages'),
        )
      })
      expect(cursoredAttempts).toBeGreaterThanOrEqual(1)
      expect(cursorlessRetries).toBeGreaterThanOrEqual(1)
    })
  })

  // ── PEND-58e — deep-review fixes (E5 / E7 / E13 / E15 / E16 / E18) ───
  describe('PEND-58e — deep-review fixes', () => {
    beforeEach(() => {
      localStorage.setItem('pageBrowser.densityV1', 'true')
      // Reset the global resolve cache so E5's tag-name fixture doesn't
      // leak across tests.
      useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
    })
    afterEach(() => {
      localStorage.removeItem('pageBrowser.densityV1')
    })

    function metaPage(id: string, content: string) {
      return {
        id,
        blockType: 'page',
        content,
        parentId: null,
        position: null,
        deletedAt: null,
        todoState: null,
        priority: null,
        dueDate: null,
        scheduledDate: null,
        pageId: id,
        lastModifiedAt: null,
        inboundLinkCount: 0,
        childBlockCount: 0,
        flags: { hasTags: false, hasTodo: false, hasScheduled: false, hasDue: false },
      }
    }

    // ── E5 — tag chip resolves the id to a tag name ─────────────────────
    it('E5: a tag chip shows the resolved tag name, not the raw id', async () => {
      const user = userEvent.setup()
      // Seed the global resolve cache with a tag id → name mapping (tags
      // are preloaded into this cache on boot in production).
      useResolveStore.getState().set('01TAGURGENT', 'urgent', false)
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [metaPage('P1', 'Apple')],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Add a Tag chip carrying the seeded tag id.
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText(t('pageBrowser.filter.facetTag')))
      const input = await screen.findByPlaceholderText(t('pageBrowser.filter.tagPlaceholder'))
      await user.type(input, '01TAGURGENT')
      await user.click(screen.getByRole('button', { name: t('pageBrowser.filter.apply') }))

      // The chip label uses the resolved name ("tag: urgent"), not the id.
      await waitFor(() => {
        expect(
          screen.getByText(t('pageBrowser.filter.summaryTag', { tag: 'urgent' })),
        ).toBeInTheDocument()
      })
      expect(
        screen.queryByText(t('pageBrowser.filter.summaryTag', { tag: '01TAGURGENT' })),
      ).not.toBeInTheDocument()
    })

    it('E5: an unresolved tag id falls back to the raw id (no broken placeholder)', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [metaPage('P1', 'Apple')],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText(t('pageBrowser.filter.facetTag')))
      const input = await screen.findByPlaceholderText(t('pageBrowser.filter.tagPlaceholder'))
      await user.type(input, '01UNKNOWNTAG')
      await user.click(screen.getByRole('button', { name: t('pageBrowser.filter.apply') }))

      // Unresolved → raw id, not the resolve store's `[[…]]` placeholder.
      await waitFor(() => {
        expect(
          screen.getByText(t('pageBrowser.filter.summaryTag', { tag: '01UNKNOWNTAG' })),
        ).toBeInTheDocument()
      })
    })

    // ── E7 — count chip + SR count use the DISTINCT matched-page count ──
    it('E7: count chip counts distinct pages, not grouped rows, in a namespaced vault', async () => {
      // A 3-page namespace subtree collapses to one tree-page row; the
      // count chip numerator must report 3 (distinct pages), not 1 (rows).
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [metaPage('P1', 'work/a'), metaPage('P2', 'work/b'), metaPage('P3', 'work/c')],
            next_cursor: null,
            has_more: false,
            total_count: 3,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      const chip = await screen.findByTestId('page-browser-count')
      // Unfiltered total form: "3 pages" (countAll). Driven by total_count,
      // unaffected by the grouped-row collapse — kept here as a guardrail.
      expect(chip).toHaveTextContent(t('pageBrowser.countAll', { count: 3 }))
    })

    it('E7: SR result announcement counts distinct pages under a text query', async () => {
      // Three pages in one namespace subtree (collapses to one tree-page
      // row). A free-text query matching all three must announce "3
      // results", not the grouped-row count.
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [
              metaPage('P1', 'work/alpha'),
              metaPage('P2', 'work/beta'),
              metaPage('P3', 'work/gamma'),
            ],
            next_cursor: null,
            has_more: false,
            total_count: 3,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText(t('pageBrowser.countAll', { count: 3 }))

      // Add a Stub chip so the SR announcement effect arms + appends a
      // result count once the (settled) refetch completes. The text query
      // "work" matches all three loaded pages.
      const searchInput = screen.getByLabelText(t('pageBrowser.searchPlaceholder'))
      await user.type(searchInput, 'work')
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))

      const liveRegion = screen.getByTestId('filter-announcement')
      // The settled count appended to the announcement is the DISTINCT
      // matched-page count (3), never the collapsed grouped-row count.
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(t('pageBrowser.filter.announceResults', { count: 3 }))
      })
    })

    // ── E13 — text-query count chip shares a basis (loaded / loaded) ────
    it('E13: text-query count chip uses the loaded count as the denominator', async () => {
      // Server filtered total is 10, but only 2 pages are loaded; a text
      // query narrows the loaded set to 1. The chip must read "1 of 2"
      // (loaded basis), NOT "1 of 10" (mixing loaded numerator with the
      // server total denominator).
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [metaPage('P1', 'Apple'), metaPage('P2', 'Banana')],
            next_cursor: null,
            has_more: true,
            // Server says there are 10 matching in total (only 2 loaded).
            total_count: 10,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const searchInput = screen.getByLabelText(t('pageBrowser.searchPlaceholder'))
      await user.type(searchInput, 'Apple')

      await waitFor(() => {
        // 1 matched (Apple) of 2 loaded — both loaded basis.
        expect(screen.getByTestId('page-browser-count')).toHaveTextContent(
          t('pageBrowser.countFiltered', { loaded: 1, total: 2 }),
        )
      })
      // It must NOT pair the loaded numerator with the server total (10).
      expect(screen.getByTestId('page-browser-count')).not.toHaveTextContent(
        t('pageBrowser.countFiltered', { loaded: 1, total: 10 }),
      )
    })

    // ── E15 — delete decrements the count chip exactly once ─────────────
    it('E15: deleting a page decrements the count chip by exactly one', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [metaPage('P1', 'Apple'), metaPage('P2', 'Banana')],
            next_cursor: null,
            has_more: false,
            total_count: 2,
          })
        }
        if (cmd === 'delete_block') return Promise.resolve(undefined)
        return Promise.resolve(undefined)
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')
      expect(screen.getByTestId('page-browser-count')).toHaveTextContent(
        t('pageBrowser.countAll', { count: 2 }),
      )

      // Delete "Apple" via its row delete control (scoped to the Apple row,
      // since each row carries its own "Delete page" button) + confirm.
      const appleRow = container.querySelector('#page-row-P1') as HTMLElement
      await user.click(
        within(appleRow).getByRole('button', { name: t('pageBrowser.deleteButton') }),
      )
      await user.click(await screen.findByRole('button', { name: /^Delete$/i }))

      // Count drops from 2 → 1 (a single decrement, not two). A
      // double-decrement (the pre-E15 in-updater bug under StrictMode)
      // would land on 0.
      await waitFor(() => {
        expect(screen.getByTestId('page-browser-count')).toHaveTextContent(
          t('pageBrowser.countAll', { count: 1 }),
        )
      })
    })

    // ── E16 — clear-all announces a dedicated message ───────────────────
    it('E16: clearing all chips announces a single clear-all message', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [metaPage('P1', 'Apple')],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Add two chips (Stub + Orphan).
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))
      await waitFor(() => {
        expect(screen.getByRole('group', { name: 'Filter: Stub' })).toBeInTheDocument()
      })
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Orphan'))
      await waitFor(() => {
        expect(screen.getByRole('group', { name: 'Filter: Orphan' })).toBeInTheDocument()
      })

      const liveRegion = screen.getByTestId('filter-announcement')
      // Clear all → a single dedicated message, NOT a per-chip removal.
      await user.click(screen.getByRole('button', { name: t('pageBrowser.filter.clearAllLabel') }))
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(t('pageBrowser.filter.announceCleared'))
      })
      // It must not announce only the first removed chip.
      expect(liveRegion).not.toHaveTextContent(
        t('pageBrowser.filter.announceRemoved', { label: 'Stub' }),
      )
    })

    // ── E18 — InvalidFilter: prefix surfaces a specific toast ───────────
    it('E18: an InvalidFilter: rejection shows a specific toast, not the generic load-failed one', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          const filters =
            (args as { filter?: { filters?: Array<{ type?: string }> } } | undefined)?.filter
              ?.filters ?? []
          // An active filter triggers the backend's InvalidFilter rejection.
          if (filters.length > 0) {
            return Promise.reject({
              kind: 'validation',
              message: 'InvalidFilter: disallowed primitive for this surface',
            })
          }
          return Promise.resolve({
            items: [metaPage('P1', 'Apple')],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // Add a chip → the metadata refetch rejects with InvalidFilter.
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))

      // The specific invalid-filter toast fires.
      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(t('pageBrowser.filter.invalidFilter'))
      })
      // And NOT the generic load-failed toast (no double-toast).
      expect(mockedToastError).not.toHaveBeenCalledWith(
        expect.stringContaining(t('pageBrowser.loadFailed')),
      )
    })

    // ── a11y — chip row with a resolved tag chip ────────────────────────
    it('E5: has no a11y violations with a resolved tag chip present', async () => {
      const user = userEvent.setup()
      useResolveStore.getState().set('01TAGURGENT', 'urgent', false)
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [metaPage('P1', 'Apple')],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return Promise.resolve(undefined)
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText(t('pageBrowser.filter.facetTag')))
      const input = await screen.findByPlaceholderText(t('pageBrowser.filter.tagPlaceholder'))
      await user.type(input, '01TAGURGENT')
      await user.click(screen.getByRole('button', { name: t('pageBrowser.filter.apply') }))
      await screen.findByText(t('pageBrowser.filter.summaryTag', { tag: 'urgent' }))

      await waitFor(
        async () => {
          expect(await axe(container)).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })
  })
})
