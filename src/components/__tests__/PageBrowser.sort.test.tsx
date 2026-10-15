// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: the sort
// dropdown, and that every sort renders the rows in the server's order (#5371).

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makePage } from '@/__tests__/fixtures'
import { pageList, stubPageRowInvoke } from '@/__tests__/helpers/invoke'
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
// (see src/__tests__/mocks/ui-select.tsx). It renders `SelectSeparator` as
// nothing, so the menu's lack of one is pinned in `e2e/pages-view.spec.ts`.

const mockedInvoke = vi.mocked(invoke)

/**
 * Serve `list_pages_with_metadata` for EVERY fetch a test triggers, keyed on
 * the command name.
 *
 * #3225 — changing the sort re-runs the page query, so a positional
 * `mockResolvedValueOnce` covers only the first fetch; the second used to
 * fall through to a fallback resolving `undefined`, which `unwrap` reports as
 * a successful (empty) response. The rendered rows survived that on stale
 * data, so the ordering assertions below were checking a list the component
 * had already been told, silently, no longer existed.
 */

function stubPageList(items: ReturnType<typeof makePage>[], totalCount: number | null = null) {
  stubPageRowInvoke(mockedInvoke, {
    list_pages_with_metadata: () => pageList(items, { total_count: totalCount }),
  })
}

function renderedTitles(): Array<string | null | undefined> {
  return within(screen.getByRole('grid'))
    .getAllByRole('row')
    .filter((r) => r.hasAttribute('data-page-item'))
    .map((r) => r.querySelector('.page-browser-item-title')?.textContent)
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
  // `mockReset`, not `clearAllMocks`: clearing wipes the call record and
  // leaves the previous test's `mockImplementation` installed, so a test that
  // forgot its own stub would silently render the last test's page list.
  // Reset restores the `vi.fn(strictInvokeFallback)` base, which fails by name
  // (#4668).
  mockedInvoke.mockReset()
})

describe('PageBrowser', () => {
  describe('sort dropdown', () => {
    it('renders the six sort options, without the loaded-pages cue', async () => {
      // More pages remain: the old cue showed exactly here.
      stubPageRowInvoke(mockedInvoke, {
        list_pages_with_metadata: () =>
          pageList([makePage({ id: 'P1', content: 'A Page' })], {
            has_more: true,
            next_cursor: 'NEXT',
          }),
      })

      render(<PageBrowser />)

      await screen.findByText('A Page')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      const options = within(sortSelect).getAllByRole('option')
      expect(options.map((o) => [o.getAttribute('value'), o.textContent])).toEqual([
        ['alphabetical', 'Alphabetical'],
        ['recent', 'Last opened'],
        ['created', 'Created'],
        ['recently-modified', 'Last edited'],
        ['most-linked', 'Most linked'],
        ['most-content', 'Most content'],
      ])
      expect(screen.queryByText(/sorted within loaded pages/i)).not.toBeInTheDocument()
    })

    it('defaults to Alphabetical sort', async () => {
      stubPageList([makePage({ id: 'P1', content: 'A Page' })])

      render(<PageBrowser />)

      await screen.findByText('A Page')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      expect(sortSelect).toHaveValue('alphabetical')
    })

    // Every option asks the server for its own order, and the rows render in
    // the order received: the stub answers each wire sort with a different
    // permutation, none of them the order a client comparator would produce.
    const PAGES = {
      Apple: makePage({ id: 'P1', content: 'Apple' }),
      Banana: makePage({ id: 'P2', content: 'Banana' }),
      Cherry: makePage({ id: 'P3', content: 'Cherry' }),
    }
    const SERVER_ORDER: Readonly<Record<string, readonly (keyof typeof PAGES)[]>> = {
      alphabetical: ['Cherry', 'Apple', 'Banana'],
      'last-opened': ['Banana', 'Cherry', 'Apple'],
      created: ['Apple', 'Cherry', 'Banana'],
      'recently-modified': ['Banana', 'Apple', 'Cherry'],
      'most-linked': ['Cherry', 'Banana', 'Apple'],
      'most-content': ['Apple', 'Banana', 'Cherry'],
    }

    function stubServerOrders(): void {
      stubPageRowInvoke(mockedInvoke, {
        list_pages_with_metadata: (args) => {
          const sort = String((args['filter'] as Record<string, unknown>)['sort'])
          const order = SERVER_ORDER[sort]
          if (!order) return Promise.reject(new Error(`no stubbed order for ${sort}`))
          return pageList(order.map((title) => PAGES[title]))
        },
      })
    }

    it.each([
      ['alphabetical', 'alphabetical'],
      ['recent', 'last-opened'],
      ['created', 'created'],
      ['recently-modified', 'recently-modified'],
      ['most-linked', 'most-linked'],
      ['most-content', 'most-content'],
    ] as const)('the %s option renders the server order of wire sort %s', async (option, wire) => {
      const user = userEvent.setup()
      stubServerOrders()

      render(<PageBrowser />)
      await screen.findByText('Apple')

      if (option !== 'alphabetical') {
        await user.selectOptions(screen.getByRole('combobox', { name: /sort order/i }), option)
      }

      await waitFor(() => {
        expect(renderedTitles()).toEqual(SERVER_ORDER[wire])
      })
    })

    it('reports the failure when the server refuses the new sort', async () => {
      const user = userEvent.setup()
      stubPageRowInvoke(mockedInvoke, {
        list_pages_with_metadata: (args) =>
          (args['filter'] as Record<string, unknown>)['sort'] === 'created'
            ? Promise.reject(new Error('backend down'))
            : pageList([PAGES.Apple]),
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')
      await user.selectOptions(screen.getByRole('combobox', { name: /sort order/i }), 'created')

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          expect.stringContaining('Failed to load pages'),
        )
      })
    })

    it('reads a stored retired `default` sort as Created', async () => {
      localStorage.setItem('page-browser-sort', 'default')
      stubPageList([makePage({ id: 'P1', content: 'A Page' })])

      render(<PageBrowser />)

      await screen.findByText('A Page')
      expect(screen.getByRole('combobox', { name: /sort order/i })).toHaveValue('created')
    })

    it('persists sort preference to localStorage', async () => {
      const user = userEvent.setup()
      stubPageList([makePage({ id: 'P1', content: 'A Page' })])

      render(<PageBrowser />)

      await screen.findByText('A Page')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'created')

      expect(localStorage.getItem('page-browser-sort')).toBe('created')
    })

    it('reads persisted sort preference from localStorage', async () => {
      localStorage.setItem('page-browser-sort', 'recent')

      stubPageList([makePage({ id: 'P1', content: 'A Page' })])

      render(<PageBrowser />)

      await screen.findByText('A Page')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      expect(sortSelect).toHaveValue('recent')
    })

    it('sort dropdown passes a11y audit', async () => {
      stubPageList([makePage({ id: 'P1', content: 'Accessible page' })])

      const { container } = render(<PageBrowser />)
      await screen.findByText('Accessible page')

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
