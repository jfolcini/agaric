// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: initial
// load, empty/skeleton states, and cursor-based pagination.

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
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
  it('calls list_pages_with_metadata on mount', async () => {
    mockedInvoke.mockResolvedValueOnce(emptyPage)

    render(<PageBrowser />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_pages_with_metadata', {
        filter: { sort: 'default', spaceId: 'SPACE_TEST', filters: [] },
        cursor: null,
        limit: 50,
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
    // from the first paint, so a second `list_pages_with_metadata` IPC
    // fires immediately without a button click. The existing
    // `<LoadMoreButton>` remains the a11y / no-JS fallback (covered
    // by its own component tests).

    // Should call with the cursor from page 1
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_pages_with_metadata', {
        filter: { sort: 'default', spaceId: 'SPACE_TEST', filters: [] },
        cursor: 'cursor_abc',
        limit: 50,
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
})
