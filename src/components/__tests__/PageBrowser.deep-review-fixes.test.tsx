// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: deep-review
// fixes.

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
  describe('deep-review fixes', () => {
    beforeEach(() => {
      // Reset the global resolve cache so E5's tag-name fixture doesn't
      // leak across tests.
      useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
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

    // ── E18 — InvalidFilter code surfaces a specific toast ──────────────
    it('E18: an InvalidFilter-coded rejection shows a specific toast, not the generic load-failed one', async () => {
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
              code: 'InvalidFilter',
              message: 'disallowed primitive for this surface',
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
