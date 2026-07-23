// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: frontend
// container hardening.

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

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
  describe('frontend container hardening', () => {
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
      // page. The cursor-bearing call rejects with the `RequiresRefresh` code, so
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
            code: 'RequiresRefresh',
            message: 'cursor sort mismatch',
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
})
