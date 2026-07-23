// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: page
// deletion, page creation (incl. under a namespace), and error feedback.

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { emptyPage, makePage } from '@/__tests__/fixtures'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { PageBrowser } from '@/components/PageBrowser'
import { t } from '@/lib/i18n'
import { usePageBrowserFiltersStore } from '@/stores/pageBrowserFilters'
import { useSpaceStore } from '@/stores/space'

// Capture every `estimateSize` callback passed to `useVirtualizer` so the
// Referential-stability test can assert the function identity
// is unchanged across re-renders that don't change `groupedRows`.
//
// The captured signature is the production one (`(index: number) => number`),
// but the mock invokes it without args throughout this test file (legacy
// Zero-arg invocation predates the change). The `(...args: never[])`
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
  localStorage.removeItem('starred-pages')
  // Compound-filter chips now live in a module-global per-space store that
  // persists to localStorage (#1750); reset both the in-memory slice and the
  // persisted key so chips added in one test don't leak into the next.
  localStorage.removeItem('agaric:page-browser-filters')
  usePageBrowserFiltersStore.setState({ filtersBySpace: {}, nextAddId: 0 })
  // Phase 2 — PageBrowser now gates its render and page query
  // on `useSpaceStore.isReady`. Seed the store so tests exercise the
  // real code path rather than the loading skeleton.
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
  describe('page creation form', () => {
    it('renders an input field and submit button', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByPlaceholderText('New page name...')).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: /New Page/i })).toBeInTheDocument()
    })

    // Input has accessible name via Label htmlFor
    it('new page input has accessible name via sr-only label', async () => {
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
  describe('handleCreateUnder setTimeout cleanup (#)', () => {
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
})
