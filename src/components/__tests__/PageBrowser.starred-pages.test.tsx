// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: starred
// pages.

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { emptyPage, makePage } from '@/__tests__/fixtures'
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

    // Clicking the star toggle moves the page between groups.
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

    // Starring a page in a multi-page vault moves it to the top
    // of the list under the "Starred" group header.
    it('clicking star moves the page to the top under the Starred header', async () => {
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

    // Starred-above-unstarred ordering with sort applied
    // independently per group.
    it('alphabetical sort applies inside each group independently', async () => {
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

    it('created-DESC sort applies inside each group independently', async () => {
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

    it('recent sort applies inside each group independently', async () => {
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

    it('toggling star round-trips a page between groups', async () => {
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

    it('namespaced pages render under the unified Pages section alongside Starred', async () => {
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

      // Under the unified model NO LONGER bypasses Starred when
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

    it('zero-starred hides the Starred header', async () => {
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

    it('all-starred hides the Pages header', async () => {
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

    it('single-page vault renders flat with no headers', async () => {
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

    it('search narrows both groups; emptied group hides its header', async () => {
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

    it('Starred header carries count in its accessible name', async () => {
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
      // Under grid flip the section header is a row inside
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

    it('viewport aria-label switches to grouped variant when starred exist', async () => {
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

    it('viewport aria-label stays plain when no starred pages', async () => {
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

    it('keyboard ArrowDown skips header rows (focus stays page-indexed)', async () => {
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

    it('a11y audit passes on grouped state', async () => {
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

    it('a11y audit passes on filtered state with grouping', async () => {
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
    // Unified Starred + Pages model
    // ---------------------------------------------------------------

    it('starred (non-namespaced) and namespaced pages coexist', async () => {
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

    it('top-level flat pages and namespace roots interleave under Pages alphabetically', async () => {
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

    it('a starred-and-namespaced page renders TWICE — once in Starred, once nested in Pages', async () => {
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

    it('star toggle from either copy of a duplicated row updates BOTH copies', async () => {
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

    it('filter narrows Pages to empty → Pages header hides, Starred remains', async () => {
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

    it('filter narrows Starred to empty → Starred header hides, Pages remains', async () => {
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

    it('keyboard ArrowDown walks every visible row in render order, including duplicates', async () => {
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

      // Render order under:
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

    it('empty vault renders the EmptyState component (no section chrome)', async () => {
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

    it('a11y audit passes on the unified Starred + Pages layout with namespaced rows', async () => {
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

      // Both sections render under Starred (the starred-and-
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

    // ScrollArea replaces bare overflow-y-auto on the page list
    it('page list is wrapped in a ScrollArea viewport', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'A page' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      const { container } = render(<PageBrowser />)

      await screen.findByText('A page')

      // The page-list grid lives on the ScrollArea viewport.
      const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
      expect(viewport).toBeInTheDocument()
      expect(viewport?.getAttribute('role')).toBe('grid')

      // No bare overflow-y-auto anywhere.
      const anyOverflowY = container.querySelector('.overflow-y-auto')
      expect(anyOverflowY).toBeNull()
    })
  })
})
