// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: the sort
// dropdown and the sort comparator vs. page metadata.

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

import { getRecentPagesForSpace } from '@/stores/recent-pages'

const mockedGetRecentPages = vi.mocked(getRecentPagesForSpace)

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
  describe('sort comparator vs metadata', () => {
    afterEach(() => {
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

    // #2602 Part A — the three server-derived sorts are ordered by the SQL
    // `ORDER BY (<key> DESC, id ASC)`; PageBrowser renders the rows in the
    // received order without a client re-sort. The mocks return rows in the
    // order the real server would (which is neither alphabetical nor id-ASC),
    // and each test asserts that exact order survives to the DOM — proving
    // the SQL ordering is the single authority.
    it('renders most-linked rows in server order (inboundLinkCount DESC, id ASC), no client re-sort', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            // Server order: Banana(5), Date(3), then the 1-count tie resolved
            // server-side by id ASC → Apple(P1) before Cherry(P3).
            items: [
              makeMetaPage({ id: 'P2', content: 'Banana', inboundLinkCount: 5 }),
              makeMetaPage({ id: 'P4', content: 'Date', inboundLinkCount: 3 }),
              makeMetaPage({ id: 'P1', content: 'Apple', inboundLinkCount: 1 }),
              makeMetaPage({ id: 'P3', content: 'Cherry', inboundLinkCount: 1 }),
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

    it('renders most-content rows in server order (childBlockCount DESC, id ASC), no client re-sort', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            // Server order: Banana(10), Date(7), then the 2-count tie by id ASC.
            items: [
              makeMetaPage({ id: 'P2', content: 'Banana', childBlockCount: 10 }),
              makeMetaPage({ id: 'P4', content: 'Date', childBlockCount: 7 }),
              makeMetaPage({ id: 'P1', content: 'Apple', childBlockCount: 2 }),
              makeMetaPage({ id: 'P3', content: 'Cherry', childBlockCount: 2 }),
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

    it('renders recently-modified rows in server order (lastModifiedAt DESC, id ASC), no client re-sort', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            // Server order: Banana (newest), Date, then the Apple/Cherry
            // timestamp tie resolved server-side by id ASC.
            items: [
              makeMetaPage({
                id: 'P2',
                content: 'Banana',
                lastModifiedAt: 1772323200000,
              }),
              makeMetaPage({
                id: 'P4',
                content: 'Date',
                lastModifiedAt: 1769904000000,
              }),
              makeMetaPage({
                id: 'P1',
                content: 'Apple',
                lastModifiedAt: 1767225600000,
              }),
              makeMetaPage({
                id: 'P3',
                content: 'Cherry',
                lastModifiedAt: 1767225600000,
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
})
