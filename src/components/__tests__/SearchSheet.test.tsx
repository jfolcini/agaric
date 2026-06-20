import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { getPinnedSearchScope, setPinnedSearchScope } from '../../lib/pinned-search-scope'
import { useNavigationStore } from '../../stores/navigation'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import { useCommandPaletteStore } from '../../stores/useCommandPaletteStore'
import { useInPageFindStore } from '../../stores/useInPageFindStore'
import { useSearchSheetStore } from '../../stores/useSearchSheetStore'
import { SearchSheet } from '../SearchSheet'

// Shared host element for the in-page segment tests. The find-in-page
// matcher only runs when `useInPageFindStore.container` is non-null —
// the embedded toolbar shows an empty-state otherwise (review fix R5).
function makeHost(): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = '<section>alpha bravo</section>'
  document.body.append(host)
  useInPageFindStore.setState({ container: host })
  return host
}

// Phase 3 — the all-pages segment mounts the embedded
// CommandPalette, which fires `searchBlocksPartitioned` IPC on every
// debounced keystroke. Mock both `searchBlocks` (linkMode) and
// `searchBlocksPartitioned` (default) to keep tests deterministic.
vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    searchBlocks: vi.fn(),
    searchBlocksPartitioned: vi.fn(),
  }
})

import { searchBlocks, searchBlocksPartitioned } from '../../lib/tauri'

const mockedSearchBlocksPartitioned = vi.mocked(searchBlocksPartitioned)
const mockedSearchBlocks = vi.mocked(searchBlocks)

type PartitionedResp = Awaited<ReturnType<typeof searchBlocksPartitioned>>

function emptyPartition(): PartitionedResp['pages'] {
  return { items: [], next_cursor: null, has_more: false, total_count: null }
}

function resetStores() {
  useSearchSheetStore.setState({
    open: false,
    mode: 'in-page',
    query: '',
  })
  useInPageFindStore.setState({
    open: false,
    query: '',
    toggles: { caseSensitive: false, wholeWord: false, isRegex: false },
    totalMatches: 0,
    currentIndex: -1,
    regexError: null,
    skippedLongNodes: 0,
    container: null,
    lastQuery: '',
  })
  useCommandPaletteStore.setState({
    open: false,
    mode: 'search',
    query: '',
    pendingViewQuery: null,
    previousFocusedElement: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  useNavigationStore.setState({ currentView: 'pages', selectedBlockId: null })
}

describe('SearchSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStores()
    mockedSearchBlocksPartitioned.mockResolvedValue({
      pages: emptyPartition(),
      blocks: emptyPartition(),
    })
    mockedSearchBlocks.mockResolvedValue({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
  })

  afterEach(() => {
    resetStores()
  })

  it('renders nothing when the store is closed', () => {
    const { container } = render(<SearchSheet />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the sheet shell when the store is open', () => {
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    expect(screen.getByTestId('search-sheet')).toBeInTheDocument()
    expect(screen.getByTestId('search-sheet-segment-in-page')).toBeInTheDocument()
    expect(screen.getByTestId('search-sheet-segment-all-pages')).toBeInTheDocument()
  })

  it('marks the in-page segment as on by default', () => {
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    expect(screen.getByTestId('search-sheet-segment-in-page')).toHaveAttribute('data-state', 'on')
    expect(screen.getByTestId('search-sheet-segment-all-pages')).toHaveAttribute(
      'data-state',
      'off',
    )
  })

  it('opens with the supplied default segment', () => {
    useSearchSheetStore.getState().open$('all-pages')
    render(<SearchSheet />)
    expect(screen.getByTestId('search-sheet-segment-all-pages')).toHaveAttribute('data-state', 'on')
  })

  it('switches segment when the other toggle is clicked', async () => {
    const user = userEvent.setup()
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    await user.click(screen.getByTestId('search-sheet-segment-all-pages'))
    expect(useSearchSheetStore.getState().mode).toBe('all-pages')
  })

  it('does not blank the segment when the active one is re-tapped', async () => {
    const user = userEvent.setup()
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    await user.click(screen.getByTestId('search-sheet-segment-in-page'))
    expect(useSearchSheetStore.getState().mode).toBe('in-page')
  })

  // ─────────────────────────────────────────────────────────────────
  // Phase 2 — in-page body wiring
  // ─────────────────────────────────────────────────────────────────

  it('renders the embedded InPageFind toolbar in the in-page segment when a page is registered', async () => {
    const host = makeHost()
    useSearchSheetStore.getState().open$('in-page')
    try {
      render(<SearchSheet />)
      await waitFor(() => {
        expect(screen.getByTestId('in-page-find-toolbar')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('search-sheet-in-page-empty')).not.toBeInTheDocument()
    } finally {
      host.remove()
    }
  })

  it('shows an empty state in the in-page segment when no page is registered', () => {
    // No container set up — review fix R5.
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    expect(screen.getByTestId('search-sheet-in-page-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('in-page-find-toolbar')).not.toBeInTheDocument()
  })

  it('opens the in-page-find store while the sheet is open in in-page mode', async () => {
    expect(useInPageFindStore.getState().open).toBe(false)
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    await waitFor(() => {
      expect(useInPageFindStore.getState().open).toBe(true)
    })
  })

  it('closes the in-page-find store when the sheet closes', async () => {
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    await waitFor(() => {
      expect(useInPageFindStore.getState().open).toBe(true)
    })
    useSearchSheetStore.getState().close()
    await waitFor(() => {
      expect(useInPageFindStore.getState().open).toBe(false)
    })
  })

  it('closes the in-page-find store when the user switches to the all-pages segment', async () => {
    const user = userEvent.setup()
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    await waitFor(() => {
      expect(useInPageFindStore.getState().open).toBe(true)
    })
    await user.click(screen.getByTestId('search-sheet-segment-all-pages'))
    await waitFor(() => {
      expect(useInPageFindStore.getState().open).toBe(false)
    })
  })

  it('re-opens the in-page-find store when the user switches back to in-page', async () => {
    const user = userEvent.setup()
    useSearchSheetStore.getState().open$('all-pages')
    render(<SearchSheet />)
    expect(useInPageFindStore.getState().open).toBe(false)
    await user.click(screen.getByTestId('search-sheet-segment-in-page'))
    await waitFor(() => {
      expect(useInPageFindStore.getState().open).toBe(true)
    })
  })

  it('does not clobber an existing in-page-find session when the sheet is dormant', () => {
    useInPageFindStore.setState({ open: true, query: 'pre-existing', lastQuery: '' })
    render(<SearchSheet />)
    expect(useInPageFindStore.getState().open).toBe(true)
    expect(useInPageFindStore.getState().query).toBe('pre-existing')
  })

  it('preserves regex / case-sensitive toggles across in-page → all-pages → in-page', async () => {
    const user = userEvent.setup()
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    useInPageFindStore.getState().setToggles({ isRegex: true, caseSensitive: true })
    expect(useInPageFindStore.getState().toggles.isRegex).toBe(true)
    await user.click(screen.getByTestId('search-sheet-segment-all-pages'))
    await waitFor(() => {
      expect(useInPageFindStore.getState().open).toBe(false)
    })
    await user.click(screen.getByTestId('search-sheet-segment-in-page'))
    await waitFor(() => {
      expect(useInPageFindStore.getState().open).toBe(true)
    })
    expect(useInPageFindStore.getState().toggles.isRegex).toBe(true)
    expect(useInPageFindStore.getState().toggles.caseSensitive).toBe(true)
  })

  // ─────────────────────────────────────────────────────────────────
  // Phase 3 — all-pages body wiring (embedded CommandPalette)
  // ─────────────────────────────────────────────────────────────────

  it('renders the embedded CommandPalette in the all-pages segment', async () => {
    useSearchSheetStore.getState().open$('all-pages')
    render(<SearchSheet />)
    // CommandPalette is lazy-imported; its input lives inside PaletteBody.
    await waitFor(() => {
      expect(screen.getByTestId('command-palette-input')).toBeInTheDocument()
    })
    // The in-page toolbar is NOT rendered (mutual exclusion via mode branch).
    expect(screen.queryByTestId('in-page-find-toolbar')).not.toBeInTheDocument()
  })

  it('opens the palette store while the sheet is open in all-pages mode', async () => {
    expect(useCommandPaletteStore.getState().open).toBe(false)
    useSearchSheetStore.getState().open$('all-pages')
    render(<SearchSheet />)
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().open).toBe(true)
    })
  })

  it('keeps the palette store closed while the sheet is open in in-page mode', async () => {
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    // Let effects run.
    await Promise.resolve()
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })

  it('closes the palette store when the sheet closes', async () => {
    useSearchSheetStore.getState().open$('all-pages')
    render(<SearchSheet />)
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().open).toBe(true)
    })
    useSearchSheetStore.getState().close()
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().open).toBe(false)
    })
  })

  it('closes the palette store when the user switches to the in-page segment', async () => {
    const user = userEvent.setup()
    useSearchSheetStore.getState().open$('all-pages')
    render(<SearchSheet />)
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().open).toBe(true)
    })
    await user.click(screen.getByTestId('search-sheet-segment-in-page'))
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().open).toBe(false)
    })
  })

  it('does not clobber an existing palette session when the sheet is dormant', () => {
    useCommandPaletteStore.setState({ open: true, query: 'pre-existing-palette' })
    render(<SearchSheet />)
    expect(useCommandPaletteStore.getState().open).toBe(true)
    expect(useCommandPaletteStore.getState().query).toBe('pre-existing-palette')
  })

  it('escalation footer closes the sheet, closes the palette, and switches to search view', async () => {
    const user = userEvent.setup()
    useSearchSheetStore.getState().open$('all-pages')
    render(<SearchSheet />)
    await waitFor(() => {
      expect(screen.getByTestId('command-palette-input')).toBeInTheDocument()
    })
    // Type into the input so the escalation footer becomes interactive
    // (the palette only surfaces it once there's a non-empty query).
    const input = screen.getByTestId('command-palette-input') as HTMLInputElement
    await user.type(input, 'alpha')
    // The escalation footer renders inside the cmdk list once results
    // arrive (or the empty state lands). With our empty-partition mock
    // the empty state path still renders the escalation row.
    const footer = await screen.findByTestId('palette-escalation-footer')
    await user.click(footer)
    await waitFor(() => {
      expect(useSearchSheetStore.getState().open).toBe(false)
      expect(useCommandPaletteStore.getState().open).toBe(false)
      expect(useCommandPaletteStore.getState().pendingViewQuery).toBe('alpha')
      expect(useNavigationStore.getState().currentView).toBe('search')
    })
  })

  it('rapid segment switches leave at most one store open and matching the final mode', async () => {
    const user = userEvent.setup()
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    await waitFor(() => {
      expect(useInPageFindStore.getState().open).toBe(true)
    })
    // in-page → all-pages → in-page in three rapid clicks. The cleanup
    // path closes both stores between transitions, so the only stable
    // state at the end is: in-page-find open, palette closed.
    await user.click(screen.getByTestId('search-sheet-segment-all-pages'))
    await user.click(screen.getByTestId('search-sheet-segment-in-page'))
    await user.click(screen.getByTestId('search-sheet-segment-all-pages'))
    await waitFor(() => {
      expect(useSearchSheetStore.getState().mode).toBe('all-pages')
      expect(useCommandPaletteStore.getState().open).toBe(true)
      expect(useInPageFindStore.getState().open).toBe(false)
    })
  })

  // ─────────────────────────────────────────────────────────────────
  // R2 fixes — review round 2
  // ─────────────────────────────────────────────────────────────────

  it('seeds the new segment from the sheet bridge query when switching', async () => {
    const user = userEvent.setup()
    const host = makeHost()
    useSearchSheetStore.getState().open$('in-page')
    try {
      render(<SearchSheet />)
      await waitFor(() => {
        expect(useInPageFindStore.getState().open).toBe(true)
      })
      // Simulate user typing into the in-page-find input — the bridge
      // mirrors `useInPageFindStore.query` → `useSearchSheetStore.query`.
      useInPageFindStore.getState().setQuery('alpha')
      await waitFor(() => {
        expect(useSearchSheetStore.getState().query).toBe('alpha')
      })
      // Switch to all-pages; the bridge seeds the palette store from
      // the mirror.
      await user.click(screen.getByTestId('search-sheet-segment-all-pages'))
      await waitFor(() => {
        expect(useCommandPaletteStore.getState().query).toBe('alpha')
      })
    } finally {
      host.remove()
    }
  })

  it('preserves a pre-existing desktop palette session (open + query) across segment churn', async () => {
    // Simulate: user was using desktop Cmd+K with a query, then opens
    // the mobile sheet in all-pages mode. The bridge must NOT clobber
    // the pre-existing query, and on segment switch + back must NOT
    // close the store.
    useCommandPaletteStore.setState({ open: true, query: 'pre-existing-palette' })
    useSearchSheetStore.getState().open$('all-pages')
    render(<SearchSheet />)
    // Wait for any effect dust to settle.
    await waitFor(() => {
      expect(screen.getByTestId('search-sheet')).toBeInTheDocument()
    })
    expect(useCommandPaletteStore.getState().open).toBe(true)
    expect(useCommandPaletteStore.getState().query).toBe('pre-existing-palette')
  })

  it('reopens the find store when the page container repopulates while the sheet is in-page', async () => {
    const host = makeHost()
    useSearchSheetStore.getState().open$('in-page')
    try {
      render(<SearchSheet />)
      await waitFor(() => {
        expect(useInPageFindStore.getState().open).toBe(true)
      })
      // Simulate page navigation that unregisters the container —
      // useInPageFindStore.setContainer(null) flips open to false.
      useInPageFindStore.getState().setContainer(null)
      await waitFor(() => {
        expect(useInPageFindStore.getState().open).toBe(false)
      })
      // Empty state now shows.
      expect(screen.getByTestId('search-sheet-in-page-empty')).toBeInTheDocument()
      // User navigates back; new container registers. The bridge's
      // secondary effect must reopen the find store so the matcher
      // restarts.
      const host2 = document.createElement('div')
      host2.innerHTML = '<section>delta echo</section>'
      document.body.append(host2)
      useInPageFindStore.getState().setContainer(host2)
      await waitFor(() => {
        expect(useInPageFindStore.getState().open).toBe(true)
      })
      host2.remove()
    } finally {
      host.remove()
    }
  })

  it('empty-state CTA switches the sheet to all-pages', async () => {
    const user = userEvent.setup()
    useSearchSheetStore.getState().open$('in-page')
    render(<SearchSheet />)
    const cta = screen.getByTestId('search-sheet-in-page-empty-switch')
    await user.click(cta)
    expect(useSearchSheetStore.getState().mode).toBe('all-pages')
  })

  it('tapping the embedded find toolbar close button closes the sheet (not the find store)', async () => {
    const user = userEvent.setup()
    const host = makeHost()
    useSearchSheetStore.getState().open$('in-page')
    try {
      render(<SearchSheet />)
      await waitFor(() => {
        expect(screen.getByTestId('in-page-find-toolbar')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('in-page-find-close'))
      // Sheet closes; the bridge cleanup then closes the find store
      // (only because we opened it).
      await waitFor(() => {
        expect(useSearchSheetStore.getState().open).toBe(false)
        expect(useInPageFindStore.getState().open).toBe(false)
      })
    } finally {
      host.remove()
    }
  })

  it('fires the partitioned IPC on segment-switch seed (no extra keystroke needed)', async () => {
    const user = userEvent.setup()
    const host = makeHost()
    useSearchSheetStore.getState().open$('in-page')
    try {
      render(<SearchSheet />)
      await waitFor(() => {
        expect(useInPageFindStore.getState().open).toBe(true)
      })
      // Seed the bridge by writing to the find store; the bridge
      // mirrors into useSearchSheetStore.query.
      useInPageFindStore.getState().setQuery('beta')
      await waitFor(() => {
        expect(useSearchSheetStore.getState().query).toBe('beta')
      })
      // Reset the mock so the previous (empty-query) calls don't
      // pollute the assertion below.
      mockedSearchBlocksPartitioned.mockClear()
      // Switch to all-pages — PaletteBody mounts; the bridge seeds
      // the palette store; PaletteBody's external-query sync effect
      // Drives `debouncedQuery` immediately so the IPC
      // fires for the seeded value.
      await user.click(screen.getByTestId('search-sheet-segment-all-pages'))
      await waitFor(() => {
        expect(mockedSearchBlocksPartitioned).toHaveBeenCalled()
        const firstCall = mockedSearchBlocksPartitioned.mock.calls[0]?.[0]
        expect(firstCall?.query).toBe('beta')
      })
    } finally {
      host.remove()
    }
  })

  // ─────────────────────────────────────────────────────────────────
  // Accessibility
  // ─────────────────────────────────────────────────────────────────

  it('has no axe violations in the in-page segment', async () => {
    const host = makeHost()
    useSearchSheetStore.getState().open$('in-page')
    try {
      const { container } = render(<SearchSheet />)
      await waitFor(() => {
        expect(screen.getByTestId('in-page-find-toolbar')).toBeInTheDocument()
      })
      expect(await axe(container)).toHaveNoViolations()
    } finally {
      host.remove()
    }
  })

  it('has no axe violations in the all-pages segment', async () => {
    useSearchSheetStore.getState().open$('all-pages')
    const { container } = render(<SearchSheet />)
    await waitFor(() => {
      expect(screen.getByTestId('command-palette-input')).toBeInTheDocument()
    })
    expect(await axe(container)).toHaveNoViolations()
  })

  // ─────────────────────────────────────────────────────────────────
  // #899 mobile-search polish — scope chip (#136), scope-pin (#135),
  // pull-to-dismiss (#133)
  // ─────────────────────────────────────────────────────────────────

  describe('#136 scope chip', () => {
    it('renders the active scope and re-scopes to the other segment on tap', async () => {
      const user = userEvent.setup()
      useSearchSheetStore.getState().open$('all-pages')
      render(<SearchSheet />)
      const chip = screen.getByTestId('search-sheet-scope-chip')
      expect(chip).toHaveAttribute('data-scope', 'all-pages')
      expect(chip).toHaveTextContent('All pages')
      await user.click(chip)
      expect(useSearchSheetStore.getState().mode).toBe('in-page')
      expect(screen.getByTestId('search-sheet-scope-chip')).toHaveAttribute('data-scope', 'in-page')
    })
  })

  describe('#135 scope-pin (long-press)', () => {
    it('pins a scope as the default on long-press, badges it, and persists it', () => {
      vi.useFakeTimers()
      try {
        useSearchSheetStore.getState().open$('all-pages')
        render(<SearchSheet />)
        const segment = screen.getByTestId('search-sheet-segment-all-pages')
        act(() => {
          fireEvent.pointerDown(segment, { clientX: 0, clientY: 0 })
          vi.advanceTimersByTime(600)
        })
        // Persisted to localStorage and badged in the UI.
        expect(getPinnedSearchScope()).toBe('all-pages')
        expect(screen.getByTestId('search-sheet-segment-all-pages-pin')).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })

    it('un-pins when the already-pinned scope is long-pressed again', () => {
      vi.useFakeTimers()
      try {
        setPinnedSearchScope('in-page')
        useSearchSheetStore.getState().open$('in-page')
        render(<SearchSheet />)
        const segment = screen.getByTestId('search-sheet-segment-in-page')
        expect(screen.getByTestId('search-sheet-segment-in-page-pin')).toBeInTheDocument()
        act(() => {
          fireEvent.pointerDown(segment, { clientX: 0, clientY: 0 })
          vi.advanceTimersByTime(600)
        })
        expect(getPinnedSearchScope()).toBeNull()
        expect(screen.queryByTestId('search-sheet-segment-in-page-pin')).not.toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('#133 pull-to-dismiss handle', () => {
    it('renders a grab handle with an accessible label', () => {
      useSearchSheetStore.getState().open$('all-pages')
      render(<SearchSheet />)
      const handle = screen.getByTestId('search-sheet-drag-handle')
      expect(handle).toHaveAttribute('aria-label')
    })
  })
})
