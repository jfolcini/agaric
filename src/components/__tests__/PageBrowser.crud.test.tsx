// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: page
// deletion, page creation (incl. under a namespace), and error feedback.

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { asPageWithMetadataRow, emptyPage, makePage, withOps } from '@/__tests__/fixtures'
import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { NewPageDialog } from '@/components/dialogs/NewPageDialog'
import { PageBrowser } from '@/components/PageBrowser'
import { useAppDialogs } from '@/hooks/useAppDialogs'
import { t } from '@/lib/i18n'
import { usePageBrowserFiltersStore } from '@/stores/pageBrowserFilters'
import { useResolveStore } from '@/stores/resolve'
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
const mockedToastSuccess = vi.mocked(toast.success)

/** Find the trash (delete) button within a page row via its aria-label. */
function findTrashButton(row: HTMLElement): HTMLButtonElement {
  return within(row).getByRole('button', { name: /delete page/i })
}

/** The `list_pages_with_metadata` response shape for a set of pages. */
/** Mounts the New page dialog the way App does: on `openNewPageDialog`. */
function DialogHost({ onOpenPage }: { onOpenPage: (pageId: string, title: string) => void }) {
  const { newPageTitle, setNewPageTitle } = useAppDialogs()
  if (newPageTitle === null) return null
  return (
    <NewPageDialog
      open
      onOpenChange={(open) => {
        if (!open) setNewPageTitle(null)
      }}
      initialTitle={newPageTitle}
      onOpenPage={onOpenPage}
    />
  )
}

function pageList(...items: ReturnType<typeof makePage>[]) {
  return {
    items: items.map(asPageWithMetadataRow),
    next_cursor: null,
    has_more: false,
    total_count: null,
  }
}

/**
 * Install a COMMAND-KEYED `invoke` implementation for one test.
 *
 * #3217 / #3225 — this file used to arrange its IPC with positional
 * `mockResolvedValueOnce` / `mockRejectedValueOnce` over a base
 * implementation that resolved `undefined` for everything else. Both halves
 * of that were hazardous:
 *
 *  - the queue is consumed in CALL order regardless of command, and
 *    `PageRow`'s hover/focus-intent prefetch (`prefetchPageSubtree`,
 *    `PAGE_PREFETCH_DWELL_MS` = 120ms) fires a genuine `load_page_subtree`
 *    whenever a pointer dwells on a row — which `userEvent.click` does as an
 *    ordinary side effect — stealing the slot meant for the command under
 *    test whenever the machine is slow enough to cross that threshold;
 *  - the `undefined` fallback then made the robbed command look like it had
 *    SUCCEEDED with no payload (`typedError` wraps any resolved value as
 *    `{ status: 'ok' }`), so the failed-delete test silently exercised a
 *    successful delete.
 *
 * Keying on the command name makes the arrangement invariant to incidental
 * calls, and unlisted commands hit the strict fallback and fail the test by
 * name instead of resolving to a phantom success.
 */
function stubInvoke(overrides: Readonly<TypedInvokeHandlers> = {}) {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      // Every PageBrowser render issues the page query.
      list_pages_with_metadata: () => emptyPage,
      // Alias resolution: no alias match unless a test says otherwise.
      resolve_page_by_alias: () => null,
      // The New page dialog's matcher and #4723's pre-create read both list
      // the space's pages; its alias lookup and FTS search find nothing.
      list_all_pages_in_space: () => [],
      list_page_aliases_by_prefix: () => [],
      search_blocks: () => ({ items: [], next_cursor: null, has_more: false, total_count: null }),
      // Speculative row prefetch — fires on pointer dwell, not on any
      // assertion; modelled here so it can never stand in for a real call.
      load_page_subtree: () => ({ blocks: [], truncated: false, total: 0 }),
      // #5269 — the header's Trash button polls the trash count for its badge.
      count_trash: () => 0,
      ...overrides,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedEstimateSizes.length = 0
  scrollToOffsetMock.mockClear()
  // PageBrowser pagination UX (2026-05-14) — scroll-restoration tests
  // round-trip values through sessionStorage; isolate each test.
  sessionStorage.clear()
  localStorage.removeItem('page-browser-sort')
  localStorage.removeItem('starred-pages')
  // Compound-filter chips now live in a module-global per-space store that
  // persists to localStorage (#1750); reset both the in-memory slice and the
  // persisted key so chips added in one test don't leak into the next.
  localStorage.removeItem('agaric:page-browser-filters')
  // An empty slice, not an absent one: absent is the default journal chip (#5370).
  usePageBrowserFiltersStore.setState({ filtersBySpace: { SPACE_TEST: [] }, nextAddId: 0 })
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
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
  // Command-keyed defaults; each test narrows them via `stubInvoke`.
  stubInvoke()
})

describe('PageBrowser', () => {
  it('has no a11y violations', async () => {
    stubInvoke({
      list_pages_with_metadata: () => pageList(makePage({ id: 'P1', content: 'Accessible page' })),
    })

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
      stubInvoke({
        list_pages_with_metadata: () => pageList(makePage({ id: 'P1', content: 'My Page' })),
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
      stubInvoke({
        list_pages_with_metadata: () => pageList(makePage({ id: 'P1', content: 'Deletable Page' })),
      })

      render(<PageBrowser />)

      await screen.findByText('Deletable Page')

      // Find and click the trash button (has aria-label)
      const pageRow = screen.getByText('Deletable Page').closest('.group') as HTMLElement
      const trashBtn = findTrashButton(pageRow)
      await user.click(trashBtn)

      // AlertDialog should describe the real soft-delete/Trash behavior.
      expect(await screen.findByText(/Delete page\?/i)).toBeInTheDocument()
      expect(screen.getByText(/can be restored from trash/i)).toBeInTheDocument()
      expect(screen.queryByText(/cannot be undone|permanently delete/i)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument()
    })

    it('cancelling the dialog keeps the page', async () => {
      const user = userEvent.setup()
      stubInvoke({
        list_pages_with_metadata: () => pageList(makePage({ id: 'P1', content: 'Keep This Page' })),
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
      stubInvoke({
        list_pages_with_metadata: () => pageList(makePage({ id: 'P1', content: 'To Be Deleted' })),
        delete_block: () =>
          withOps({
            block_id: 'P1',
            deleted_at: 1767225600000,
            descendants_affected: 0,
            affected_page_ids: [],
          }),
      })

      render(<PageBrowser />)

      await screen.findByText('To Be Deleted')

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

    it('Undo refetches and restores the deleted row and authoritative total', async () => {
      const user = userEvent.setup()
      const restoredPage = makePage({ id: 'P1', content: 'Undo this deletion' })
      let deleted = false
      stubInvoke({
        list_pages_with_metadata: () => ({
          items: deleted ? [] : [asPageWithMetadataRow(restoredPage)],
          next_cursor: null,
          has_more: false,
          total_count: deleted ? 0 : 1,
        }),
        delete_block: () => {
          deleted = true
          return withOps({
            block_id: 'P1',
            deleted_at: 1767225600000,
            descendants_affected: 0,
            affected_page_ids: [],
          })
        },
        restore_blocks_by_ids: () => {
          deleted = false
          return { affected_count: 1 }
        },
      })

      render(<PageBrowser />)
      expect(await screen.findByText('Undo this deletion')).toBeInTheDocument()
      expect(await screen.findByTestId('page-browser-count')).toHaveTextContent('1 page')

      const pageRow = screen.getByText('Undo this deletion').closest('.group') as HTMLElement
      await user.click(findTrashButton(pageRow))
      await user.click(await screen.findByRole('button', { name: /^Delete$/i }))
      await waitFor(() => {
        expect(screen.queryByText('Undo this deletion')).not.toBeInTheDocument()
      })

      const deleteToast = mockedToastSuccess.mock.calls.find(
        ([message]) => message === 'Page deleted',
      )
      const options = deleteToast?.[1] as { action?: { onClick?: () => void } } | undefined
      if (!options?.action?.onClick) throw new Error('Expected delete toast to expose Undo')
      act(() => {
        options.action?.onClick?.()
      })

      expect(await screen.findByText('Undo this deletion')).toBeInTheDocument()
      expect(await screen.findByTestId('page-browser-count')).toHaveTextContent('1 page')
      expect(mockedInvoke).toHaveBeenCalledWith('restore_blocks_by_ids', {
        blockIds: ['P1'],
      })
      expect(
        mockedInvoke.mock.calls.filter(([command]) => command === 'list_pages_with_metadata'),
      ).toHaveLength(2)
    })
  })
  // #5637 — the inline create form became the New page dialog. These drive
  // the real path: the view's New Page button → `openNewPageDialog` →
  // `useAppDialogs` → the dialog (`DialogHost` stands in for App).
  describe('page creation through the New page dialog', () => {
    async function openFromPagesView(onPageSelect = vi.fn()) {
      const user = userEvent.setup()
      render(
        <>
          <PageBrowser onPageSelect={onPageSelect} />
          <DialogHost onOpenPage={onPageSelect} />
        </>,
      )
      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })
      await user.click(screen.getByRole('button', { name: t('pageBrowser.newPage') }))
      const input = await screen.findByRole('textbox', { name: t('newPageDialog.inputLabel') })
      return { user, input }
    }

    it('New Page opens the dialog with its labelled title field focused', async () => {
      stubInvoke()
      const { input } = await openFromPagesView()

      expect(input).toHaveAttribute('id', 'new-page-name')
      expect(input).toHaveFocus()
    })

    it('creates the page with the typed name via Enter and navigates to it', async () => {
      stubInvoke({ create_page_in_space: () => 'P_NEW' })
      const onPageSelect = vi.fn()
      const { user, input } = await openFromPagesView(onPageSelect)

      await user.type(input, 'My Custom Page{Enter}')

      await waitFor(() => {
        expect(onPageSelect).toHaveBeenCalledWith('P_NEW', 'My Custom Page')
      })
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'create_page_in_space')).toEqual([
        [
          'create_page_in_space',
          { parentId: null, content: 'My Custom Page', spaceId: 'SPACE_TEST' },
        ],
      ])
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('a failed create shows the error in the dialog and keeps it open', async () => {
      stubInvoke({ create_page_in_space: () => Promise.reject(new Error('Create failed')) })
      const onPageSelect = vi.fn()
      const { user, input } = await openFromPagesView(onPageSelect)

      await user.type(input, 'Failing Page{Enter}')

      expect(await screen.findByRole('alert')).toHaveTextContent(
        t('pageBrowser.createFailed', { error: 'Error: Create failed' }),
      )
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(onPageSelect).not.toHaveBeenCalled()
    })
  })
  describe('error feedback', () => {
    it('shows toast on failed page load', async () => {
      stubInvoke({
        list_pages_with_metadata: () => Promise.reject(new Error('Network error')),
      })

      render(<PageBrowser />)

      await waitFor(() => {
        expect(mockedToastError).toHaveBeenCalledWith(
          expect.stringContaining('Failed to load pages'),
        )
      })
    })

    it('shows toast on failed page deletion', async () => {
      const user = userEvent.setup()
      // #3217 — route by COMMAND NAME rather than call order. A positional
      // `mockResolvedValueOnce`/`mockRejectedValueOnce` pair is consumed by
      // whichever IPC call lands next, regardless of which Tauri command it
      // is for. `PageRow`'s hover/focus-intent speculative prefetch
      // (`prefetchPageSubtree`, `PAGE_PREFETCH_DWELL_MS` = 120ms — see
      // `@/lib/prefetch-page-subtree`) fires a genuine `load_page_subtree`
      // IPC call whenever the pointer dwells on a page row for >120ms, which
      // `userEvent.click(trashBtn)` does as an ordinary side effect of
      // synthesizing the pointer-enter/click sequence. When the interaction
      // is slow enough for that debounce to fire (reliably so under CPU
      // contention — reproduces 100% under load, ~0% idle, so it is a
      // wall-clock THRESHOLD, not a coin-flip race), that call consumes the
      // `mockRejectedValueOnce` meant for `delete_block`; `delete_block`
      // then falls through to the base implementation. #3225 made that
      // fallback loud, but before it did, the base resolved `undefined`,
      // which `typedError`/`unwrap` treat as a *successful* `{ status: 'ok',
      // data: undefined }` — so the delete silently "succeeded" (row
      // removed, a success toast fired) instead of surfacing the intended
      // failure, and this assertion timed out. Keying on the command name
      // makes the outcome invariant to any such incidental IPC call, in
      // isolation or in the full file.
      stubInvoke({
        list_pages_with_metadata: () => pageList(makePage({ id: 'P1', content: 'Fail Delete' })),
        delete_block: () => Promise.reject(new Error('Delete failed')),
      })

      render(<PageBrowser />)

      await screen.findByText('Fail Delete')

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
      stubInvoke({
        list_pages_with_metadata: () => pageList(makePage({ id: 'P1', content: 'work/project-a' })),
      })

      render(<PageBrowser />)

      await screen.findByText('work')

      const createBtn = screen.getByRole('button', { name: /create page under work/i })
      expect(createBtn).toBeInTheDocument()
    })

    it('clicking + on a namespace opens the New page dialog with the prefix filled in', async () => {
      const user = userEvent.setup()
      stubInvoke({
        list_pages_with_metadata: () => pageList(makePage({ id: 'P1', content: 'work/project-a' })),
      })

      render(
        <>
          <PageBrowser />
          <DialogHost onOpenPage={vi.fn()} />
        </>,
      )

      await screen.findByText('work')

      const createBtn = screen.getByRole('button', { name: /create page under work/i })
      await user.click(createBtn)

      const input = await screen.findByRole('textbox', { name: t('newPageDialog.inputLabel') })
      expect(input).toHaveValue('work/')
      expect(screen.getByTestId('new-page-parent-path')).toHaveTextContent(
        t('newPageDialog.parentPath', { path: 'work' }),
      )
    })

    it('a11y: + button has proper aria-label with namespace path', async () => {
      stubInvoke({
        list_pages_with_metadata: () =>
          pageList(
            makePage({ id: 'P1', content: 'work/dev/task-1' }),
            makePage({ id: 'P2', content: 'work/dev/task-2' }),
          ),
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
      stubInvoke({
        list_pages_with_metadata: () =>
          pageList(
            makePage({ id: 'P1', content: 'work/project-a' }),
            makePage({ id: 'P2', content: 'work' }),
          ),
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
