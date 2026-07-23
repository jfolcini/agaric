// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: text
// search/filter, the SearchInput clear button, and compound filter chips.

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  describe('search/filter', () => {
    it('search filters pages and shows only matches', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Meeting notes' }),
          makePage({ id: 'P2', content: 'Shopping list' }),
          makePage({ id: 'P3', content: 'Meeting agenda' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Meeting')

      // Matching pages visible (title attribute stays intact despite highlight)
      expect(screen.getByTitle('Meeting notes')).toBeInTheDocument()
      expect(screen.getByTitle('Meeting agenda')).toBeInTheDocument()
      // Non-matching page hidden
      expect(screen.queryByTitle('Shopping list')).not.toBeInTheDocument()
    })

    it('search filters namespaced pages and expands matching ancestors', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work/project-b' }),
          makePage({ id: 'P3', content: 'personal/journal' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('project-a')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'project-a')

      // Matching page should be visible
      expect(screen.getByText(/project-a/)).toBeInTheDocument()
      // Ancestor folder should be visible
      expect(screen.getByText('work')).toBeInTheDocument()
      // Non-matching pages should not be visible
      expect(screen.queryByText('project-b')).not.toBeInTheDocument()
      expect(screen.queryByText('journal')).not.toBeInTheDocument()
      expect(screen.queryByText('personal')).not.toBeInTheDocument()
    })

    it('search with no matches shows empty state', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Meeting notes' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'zzz-nonexistent')

      expect(screen.queryByText('Meeting notes')).not.toBeInTheDocument()
      expect(screen.getByText('No matching pages')).toBeInTheDocument()
    })

    it('search is case-insensitive', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Meeting Notes' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('Meeting Notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'meeting')

      expect(screen.getByTitle('Meeting Notes')).toBeInTheDocument()
    })

    // Unicode-aware filter regression tests. Plain
    // `.toLowerCase().includes(...)` fails these cases; the filter
    // now delegates to `matchesSearchFolded` in `@/lib/fold-for-search`.

    it('search matches Turkish İstanbul when query is lowercase istanbul', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'İstanbul' }),
          makePage({ id: 'P2', content: 'Ankara' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('İstanbul')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'istanbul')

      expect(screen.getByTitle('İstanbul')).toBeInTheDocument()
      expect(screen.queryByText('Ankara')).not.toBeInTheDocument()
    })

    it('search matches German Straße when query is ASCII strasse', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Straße' }),
          makePage({ id: 'P2', content: 'München' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Straße')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'strasse')

      expect(screen.getByTitle('Straße')).toBeInTheDocument()
      expect(screen.queryByText('München')).not.toBeInTheDocument()
    })

    it('search matches accented café when query omits the accent', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'café meeting' }),
          makePage({ id: 'P2', content: 'lunch' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('café meeting')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'cafe')

      expect(screen.getByTitle('café meeting')).toBeInTheDocument()
      expect(screen.queryByText('lunch')).not.toBeInTheDocument()
    })

    it('clearing search shows all pages again', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Meeting notes' }),
          makePage({ id: 'P2', content: 'Shopping list' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Meeting')

      expect(screen.queryByText('Shopping list')).not.toBeInTheDocument()

      await user.clear(searchInput)

      expect(screen.getByText('Meeting notes')).toBeInTheDocument()
      expect(screen.getByText('Shopping list')).toBeInTheDocument()
    })

    // -----------------------------------------------------------------
    // B-2: alias-resolution stale-fetch guard. When a slow
    // promise resolves AFTER a newer query has been issued, the older
    // result must be discarded so `aliasMatchId` reflects the latest
    // query — not the older in-flight one.
    // -----------------------------------------------------------------

    it('alias resolution discards stale promise resolution (B-2)', async () => {
      const user = userEvent.setup()

      // Two pages: `Apple` (P_APPLE) and `Banana` (P_BANANA). The alias
      // resolver below returns the page id matching the query, with an
      // intentional out-of-order resolution: the older `App` query
      // resolves AFTER the newer `Banana` query.
      mockedInvoke.mockReset()
      let resolveApp!: (v: unknown) => void
      let resolveBanana!: (v: unknown) => void
      const aliasCalls: string[] = []
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [
              makePage({ id: 'P_APPLE', content: 'Apple' }),
              makePage({ id: 'P_BANANA', content: 'Banana' }),
            ],
            next_cursor: null,
            has_more: false,
            total_count: null,
          })
        }
        if (cmd === 'resolve_page_by_alias') {
          const query = (args as any)?.alias as string | undefined
          aliasCalls.push(query ?? '')
          if (query === 'App') {
            return new Promise((resolve) => {
              resolveApp = resolve
            })
          }
          if (query === 'Banana') {
            return new Promise((resolve) => {
              resolveBanana = resolve
            })
          }
          return Promise.resolve(null)
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const searchInput = screen.getByPlaceholderText('Search pages...')

      // Type the first (stale) query.
      await user.type(searchInput, 'App')
      await waitFor(() => {
        expect(aliasCalls.includes('App')).toBe(true)
      })

      // Replace it with a newer query — this fires a second IPC and
      // increments `aliasReqIdRef`, marking the in-flight `App` promise
      // as stale.
      await user.clear(searchInput)
      await user.type(searchInput, 'Banana')
      await waitFor(() => {
        expect(aliasCalls.includes('Banana')).toBe(true)
      })

      // Resolve the newer query first → this is the truthy result and
      // should set `aliasMatchId` to `P_BANANA`.
      await act(async () => {
        resolveBanana(['P_BANANA', 'Banana'])
      })

      // Now resolve the OLDER `App` query with `P_APPLE`. Without the
      // stale-fetch guard this would overwrite `aliasMatchId` and the
      // `App` page would briefly be highlighted in the filtered list,
      // which is impossible because the search input no longer contains
      // `App`. With the guard, the old result is discarded.
      await act(async () => {
        resolveApp(['P_APPLE', 'Apple'])
      })

      // After both promises settle, the live filter still reads
      // `Banana`, so only `Banana` is visible. The stale `Apple` match
      // never leaks through.
      expect(screen.getByTitle('Banana')).toBeInTheDocument()
      expect(screen.queryByText('Apple')).not.toBeInTheDocument()
    })
  })
  describe('SearchInput clear button', () => {
    it('new-page input shows clear button when non-empty and clearing resets name + disables submit', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce(emptyPage)

      render(<PageBrowser />)

      await waitFor(() => {
        expect(screen.getByText(/No pages yet/)).toBeInTheDocument()
      })

      const input = screen.getByPlaceholderText('New page name...') as HTMLInputElement
      const submitBtn = screen.getByRole('button', { name: /New Page/i })
      expect(submitBtn).toBeDisabled()
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()

      await user.type(input, 'Draft Page')
      expect(input.value).toBe('Draft Page')
      // Validation wiring still works — submit is enabled now.
      expect(submitBtn).toBeEnabled()

      const clearBtn = screen.getByTestId('search-input-clear')
      expect(clearBtn).toBeInTheDocument()

      await user.click(clearBtn)
      expect(input.value).toBe('')
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()
      // Validation wiring still works — submit is disabled again after clear.
      expect(submitBtn).toBeDisabled()
    })

    it('filter-search input shows clear button when non-empty and clearing restores full list', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Meeting notes' }),
          makePage({ id: 'P2', content: 'Shopping list' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...') as HTMLInputElement
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()

      await user.type(searchInput, 'Meeting')
      expect(searchInput.value).toBe('Meeting')
      // Filter applied — non-matching page hidden.
      expect(screen.queryByTitle('Shopping list')).not.toBeInTheDocument()

      const clearBtn = screen.getByTestId('search-input-clear')
      expect(clearBtn).toBeInTheDocument()

      await user.click(clearBtn)
      expect(searchInput.value).toBe('')
      expect(screen.queryByTestId('search-input-clear')).not.toBeInTheDocument()
      // Filter cleared — both pages are visible again.
      expect(screen.getByText('Meeting notes')).toBeInTheDocument()
      expect(screen.getByText('Shopping list')).toBeInTheDocument()
    })

    it('has no a11y violations when a clear button is visible on the filter input', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'Meeting notes' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Meeting notes')

      const searchInput = screen.getByPlaceholderText('Search pages...')
      await user.type(searchInput, 'Meet')
      expect(screen.getByTestId('search-input-clear')).toBeInTheDocument()

      // Scope the a11y audit to the SearchInput wrapper containing the
      // visible clear button. The surrounding page-list uses `role="row"`
      // rows containing nested buttons (star / select / delete) which
      // pre-dates this migration and is orthogonal to the SearchInput
      // clear-button affordance under test here. axe cold-load under
      // parallel-worker contention benefits from the waitFor + larger
      // per-test timeout (see AGENTS.md).
      const clearBtn = screen.getByTestId('search-input-clear')
      const searchWrapper = clearBtn.closest('[data-slot="search-input"]') as HTMLElement | null
      expect(searchWrapper).not.toBeNull()

      await waitFor(
        async () => {
          const results = await axe(searchWrapper as HTMLElement)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    }, 10000)
  })
  describe('compound filters', () => {
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

    /** Pull the `filter.filters` array from the most-recent metadata call. */
    function lastMetadataFilters(): unknown[] {
      const calls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_pages_with_metadata')
      const last = calls.at(-1)
      const arg = last?.[1] as { filter?: { filters?: unknown[] } } | undefined
      return arg?.filter?.filters ?? []
    }

    it('threads a Stub chip into the metadata IPC and clears it on remove', async () => {
      const user = userEvent.setup()
      // P2-D — vary the mock return on the `filters` arg so this exercises
      // one real narrowing case at the React level (not just IPC wiring):
      // unfiltered returns both pages; with a Stub chip the server reply
      // narrows to the stub page only. (The full filter→SQL semantics are
      // covered backend-side in the Rust suite.)
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
            total_count: items.length,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      // Unfiltered: both pages are present.
      await screen.findByText('Apple')
      expect(screen.getByText('Banana')).toBeInTheDocument()

      // Open the Add-Filter popover and pick the Pages-only "Stub" facet.
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))

      // The IPC should now be called with a Stub primitive.
      await waitFor(() => {
        expect(lastMetadataFilters()).toContainEqual({ type: 'Stub' })
      })

      // The varied mock narrows the result: Banana drops, Apple stays.
      await waitFor(() => {
        expect(screen.queryByText('Banana')).not.toBeInTheDocument()
      })
      expect(screen.getByText('Apple')).toBeInTheDocument()

      // A chip renders for the active filter.
      expect(screen.getByRole('group', { name: 'Filter: Stub' })).toBeInTheDocument()

      // Remove the chip → the next IPC call carries no filters and the
      // narrowed-out page returns.
      await user.click(screen.getByRole('button', { name: 'Remove filter Stub' }))
      await waitFor(() => {
        expect(lastMetadataFilters()).toEqual([])
      })
      await screen.findByText('Banana')
    })

    it('renders the no-match state (not the empty-space state) when a chip narrows to zero', async () => {
      // P0-B — with an empty text box but an active chip, a zero-row
      // server reply must render the "No matching pages" no-match state,
      // NOT the "No pages yet / Create your first page" empty-space state
      // (which falsely tells a user with a full graph it's empty).
      const user = userEvent.setup()
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          const filters =
            (args as { filter?: { filters?: Array<{ type?: string }> } } | undefined)?.filter
              ?.filters ?? []
          // Unfiltered shows one page so the chip-row (and Add-filter
          // button) are reachable; the Stub chip narrows to zero rows.
          const items = filters.length > 0 ? [] : [metaPage('P1', 'Apple')]
          return Promise.resolve({
            items,
            next_cursor: null,
            has_more: false,
            total_count: items.length,
          })
        }
        return Promise.resolve(undefined)
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      // Add a Stub chip → server returns zero rows.
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))

      // The no-match message renders.
      await screen.findByText(t('pageBrowser.noMatches'))

      // The empty-space state is NOT shown.
      expect(screen.queryByText(t('pageBrowser.noPages'))).not.toBeInTheDocument()
      expect(screen.queryByText(t('pageBrowser.createFirst'))).not.toBeInTheDocument()

      // The remove-filter control is present so the user can widen again.
      expect(screen.getByRole('button', { name: 'Remove filter Stub' })).toBeInTheDocument()

      // a11y audit of the chip-only zero-result view.
      await waitFor(async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      })
    })

    it('announces filter add and remove in a polite live region (P1-F1)', async () => {
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
            total_count: items.length,
          })
        }
        return Promise.resolve(undefined)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const liveRegion = screen.getByTestId('filter-announcement')
      // Nothing announced before any chip interaction.
      expect(liveRegion).toHaveTextContent('')

      // Add a Stub chip → "Filter added: Stub. 1 result."
      await user.click(screen.getByRole('button', { name: 'Add filter' }))
      await user.click(await screen.findByText('Stub'))
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(
          t('pageBrowser.filter.announceAdded', { label: 'Stub' }),
        )
      })
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(t('pageBrowser.filter.announceResults', { count: 1 }))
      })

      // Remove the chip → "Filter removed: Stub. 2 results."
      await user.click(screen.getByRole('button', { name: 'Remove filter Stub' }))
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(
          t('pageBrowser.filter.announceRemoved', { label: 'Stub' }),
        )
      })
      await waitFor(() => {
        expect(liveRegion).toHaveTextContent(t('pageBrowser.filter.announceResults', { count: 2 }))
      })
    })
  })
})
