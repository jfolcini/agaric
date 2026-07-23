// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: density
// rows.

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { PageBrowser } from '@/components/PageBrowser'
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
  describe('density rows', () => {
    afterEach(() => {
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

    it('calls list_pages_with_metadata (and not list_blocks) on mount', async () => {
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
      // an AppError carrying the structured `RequiresRefresh` code (v2 cursor mismatch); the
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
              code: 'RequiresRefresh',
              message: 'cursor sort mismatch',
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
})
