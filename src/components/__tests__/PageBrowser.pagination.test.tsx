// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: pagination
// UX (count chip, auto-load, scroll restoration) and virtualizer estimateSize
// referential stability.

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makePage } from '@/__tests__/fixtures'
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
      // "X of Y matching" form. the text box narrows only
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
        expect(mockedInvoke).toHaveBeenCalledWith('list_pages_with_metadata', {
          filter: { sort: 'default', spaceId: 'SPACE_TEST', filters: [] },
          cursor: 'cursor_abc',
          limit: 50,
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
  describe('  estimateSize referential stability', () => {
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
      const initialEstimateSize = capturedEstimateSizes.at(-1)

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
})
