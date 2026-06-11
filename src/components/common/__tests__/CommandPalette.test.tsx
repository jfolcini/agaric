/**
 * Component-level tests for the Cmd/Ctrl+K palette (PEND-61 —
 * `CommandPalette`, successor to PEND-51's `SearchPalette`).
 *
 * Port matrix (vs `SearchPalette.test.tsx`):
 *  - visibility ……………………………… verbatim, renamed test ids.
 *  - empty state (recent pages) ……………… verbatim, renamed test ids.
 *  - parallel queries → partitioned …… switched mock from `searchBlocks`
 *    to `searchBlocksPartitioned`. Single IPC per keystroke now.
 *  - caps + surplus pill (`mergeAndRankGroups`) …… verbatim (the export
 *    is re-exported from CommandPalette.tsx).
 *  - keyboard navigation ……………………… relaxed: cmdk owns
 *    `aria-activedescendant`, so we assert the side effect (Enter fires
 *    `navigateToPage` with the correct args) rather than the
 *    intermediate descendant id.
 *  - click semantics (plain Enter + Cmd/Ctrl+Enter) …… port. The
 *    modifier flow goes through the wrapper's `onKeyDown` so we fire
 *    KeyDown on the list (not on the input).
 *  - escalation footer ……………………… verbatim.
 *  - `[[page]]` autocomplete …………… verbatim.
 *  - a11y (axe + IPC error path) …………… verbatim; axe now scans BOTH
 *    search mode and commands mode.
 *  - NEW: commands mode (typing `>` flips mode, mode chip toggles modes,
 *    6 cmd items rendered, `go-settings` + `search-everywhere` side
 *    effects).
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Editor } from '@tiptap/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { CommandPalette, mergeAndRankGroups } from '@/components/common/CommandPalette'
import { setActiveEditor } from '@/editor/active-editor'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

// Mock the partitioned IPC so we can drive its responses deterministically
// from tests. Spread the actual module so other re-exports (paginationLimit,
// etc.) stay intact.
vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>()
  return {
    ...actual,
    // PEND-61 CR — linkMode now fires `searchBlocks({blockTypeFilter:
    // 'page'})` for the page-only guarantee; non-linkMode still fires
    // `searchBlocksPartitioned`. Both must be mocked.
    searchBlocks: vi.fn(),
    searchBlocksPartitioned: vi.fn(),
  }
})

// PEND-58g UX-A1 — pin the viewport boolean so mobile-escalation tests
// can flip it. Default `false` matches jsdom's 1024px innerWidth, so
// the desktop suite keeps the query-gated inline cmdk footer.
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

import { useIsMobile } from '@/hooks/useIsMobile'
import { searchBlocks, searchBlocksPartitioned } from '@/lib/tauri'

const mockedSearchBlocksPartitioned = vi.mocked(searchBlocksPartitioned)
const mockedSearchBlocks = vi.mocked(searchBlocks)
const mockedUseIsMobile = vi.mocked(useIsMobile)

type PartitionedResp = Awaited<ReturnType<typeof searchBlocksPartitioned>>
type SearchRow = PartitionedResp['pages']['items'][number]

function resetStore(): void {
  useCommandPaletteStore.setState({
    open: false,
    mode: 'search',
    query: '',
    pendingViewQuery: null,
    previousFocusedElement: null,
  })
}

function makePageRow(id: string, content: string): SearchRow {
  return {
    id,
    block_type: 'page',
    content,
    parent_id: null,
    page_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    snippet: null,
    match_offsets: [],
  } as SearchRow
}

function makeBlockRow(id: string, content: string, pageId: string, snippet?: string): SearchRow {
  return {
    id,
    block_type: 'content',
    content,
    parent_id: null,
    page_id: pageId,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    snippet: snippet ?? null,
    match_offsets: [],
  } as SearchRow
}

function emptyPartition(): PartitionedResp['pages'] {
  return { items: [], next_cursor: null, has_more: false, total_count: null }
}

function partitionedResp(
  pages: ReadonlyArray<SearchRow>,
  blocks: ReadonlyArray<SearchRow>,
): PartitionedResp {
  return {
    pages: { items: [...pages], next_cursor: null, has_more: false, total_count: null },
    blocks: { items: [...blocks], next_cursor: null, has_more: false, total_count: null },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` wipes the mock implementation, so re-pin the
  // default desktop viewport (PEND-58g UX-A1). Mobile tests override.
  mockedUseIsMobile.mockReturnValue(false)
  localStorage.clear()
  resetStore()
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
  // Default: empty partitions so tests that don't care about results still
  // render a non-crashing palette body.
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
  resetStore()
  // #82 — the active-editor registry is a module singleton; clear it so
  // a registered mock can't leak into an unrelated test.
  setActiveEditor(null)
})

function openPalette(): void {
  act(() => {
    useCommandPaletteStore.getState().open$()
  })
}

describe('CommandPalette — visibility', () => {
  it('renders nothing when the store is closed', () => {
    render(<CommandPalette />)
    expect(screen.queryByTestId('command-palette')).toBeNull()
  })

  it('mounts the dialog when the store flag opens', () => {
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('command-palette')).toBeInTheDocument()
    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument()
  })

  it('closes via Escape', async () => {
    render(<CommandPalette />)
    openPalette()
    await userEvent.keyboard('{Escape}')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })
})

describe('CommandPalette — empty state', () => {
  it('shows recent pages when no query is typed', () => {
    // PEND-67 forward-port: PR #31 made `recent-pages.ts` space-scoped
    // (storage key `recent_pages:<spaceId>`). Seed the SPACE_TEST slot
    // so `getRecentPages()` returns this entry under the active space.
    localStorage.setItem(
      'recent_pages:SPACE_TEST',
      JSON.stringify([
        { id: 'PAGE_RECENT', title: 'Recent Project', visitedAt: '2026-05-01T00:00:00Z' },
      ]),
    )
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByText('Recent Project')).toBeInTheDocument()
    expect(screen.getByTestId('palette-recents-group')).toBeInTheDocument()
  })
})

describe('CommandPalette — recents pinning (PEND-67 Phase 4)', () => {
  it('clicking the pin button toggles the pinned state without navigating', async () => {
    localStorage.setItem(
      'recent_pages:SPACE_TEST',
      JSON.stringify([{ id: 'PAGE_A', title: 'Alpha', visitedAt: '2026-05-19T00:00:00Z' }]),
    )
    render(<CommandPalette />)
    openPalette()
    const pin = await screen.findByTestId('palette-recent-pin-PAGE_A')
    fireEvent.click(pin)
    // Persisted as pinned.
    const raw = localStorage.getItem('recent_pages:SPACE_TEST') ?? '[]'
    const parsed = JSON.parse(raw) as Array<{ id: string; pinned?: boolean }>
    expect(parsed[0]?.pinned).toBe(true)
    // The palette did NOT navigate away on the pin click.
    expect(useCommandPaletteStore.getState().open).toBe(true)
  })

  it('pinned recents sort above unpinned recents', async () => {
    localStorage.setItem(
      'recent_pages:SPACE_TEST',
      JSON.stringify([
        { id: 'PAGE_OLD', title: 'OldPinned', visitedAt: '2026-01-01T00:00:00Z', pinned: true },
        { id: 'PAGE_NEW', title: 'NewUnpinned', visitedAt: '2026-05-19T00:00:00Z' },
      ]),
    )
    render(<CommandPalette />)
    openPalette()
    // Find both recent rows by data-testid.
    const old = await screen.findByTestId('palette-recent-PAGE_OLD')
    const fresh = await screen.findByTestId('palette-recent-PAGE_NEW')
    // The pinned row's DOM ordering comes before the unpinned one
    // (compareDocumentPosition: 4 == DOCUMENT_POSITION_FOLLOWING).
    expect(old.compareDocumentPosition(fresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(old.getAttribute('data-pinned')).toBe('true')
    expect(fresh.getAttribute('data-pinned')).toBeNull()
  })
})

describe('CommandPalette — action menu (PEND-67 Phase 5)', () => {
  function seedRecents() {
    localStorage.setItem(
      'recent_pages:SPACE_TEST',
      JSON.stringify([{ id: 'PAGE_R', title: 'Recent', visitedAt: '2026-05-19T00:00:00Z' }]),
    )
  }

  it('Tab on a focused recent row opens the action menu', async () => {
    seedRecents()
    render(<CommandPalette />)
    openPalette()
    const recentRow = await screen.findByTestId('palette-recent-PAGE_R')
    // Seed cmdk's aria-selected so the Tab handler can find the row.
    recentRow.setAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
    expect(await screen.findByTestId('palette-action-menu')).toBeInTheDocument()
    expect(screen.getByTestId('palette-action-open')).toBeInTheDocument()
    expect(screen.getByTestId('palette-action-open-new-tab')).toBeInTheDocument()
    expect(screen.getByTestId('palette-action-pin')).toBeInTheDocument()
  })

  it('Escape closes the action menu without closing the palette', async () => {
    seedRecents()
    render(<CommandPalette />)
    openPalette()
    const recentRow = await screen.findByTestId('palette-recent-PAGE_R')
    recentRow.setAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
    const menu = await screen.findByTestId('palette-action-menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByTestId('palette-action-menu')).toBeNull()
    expect(useCommandPaletteStore.getState().open).toBe(true)
  })

  it('selecting "Open in new tab" calls openInNewTab and closes', async () => {
    seedRecents()
    const openInNewTabSpy = vi.fn()
    useTabsStore.setState({ openInNewTab: openInNewTabSpy } as never, true)
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [], label: '' }],
      activeTabIndex: 0,
    })
    // Re-set openInNewTab after the partial setState above which clobbers the spy.
    useTabsStore.setState({ openInNewTab: openInNewTabSpy } as never)
    render(<CommandPalette />)
    openPalette()
    const recentRow = await screen.findByTestId('palette-recent-PAGE_R')
    recentRow.setAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
    fireEvent.click(await screen.findByTestId('palette-action-open-new-tab'))
    expect(openInNewTabSpy).toHaveBeenCalledWith('PAGE_R', 'Recent')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })

  it('selecting "Pin" toggles the pinned state', async () => {
    seedRecents()
    render(<CommandPalette />)
    openPalette()
    const recentRow = await screen.findByTestId('palette-recent-PAGE_R')
    recentRow.setAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
    fireEvent.click(await screen.findByTestId('palette-action-pin'))
    const raw = localStorage.getItem('recent_pages:SPACE_TEST') ?? '[]'
    const parsed = JSON.parse(raw) as Array<{ id: string; pinned?: boolean }>
    expect(parsed[0]?.pinned).toBe(true)
    // Action ran, menu closed; palette stays open because pin is not a nav action.
    expect(screen.queryByTestId('palette-action-menu')).toBeNull()
    expect(useCommandPaletteStore.getState().open).toBe(true)
  })

  it('Tab on a command-row is a no-op (no menu for command rows in v1)', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    const cmd = await screen.findByTestId('palette-cmd-go-pages')
    cmd.setAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
    expect(screen.queryByTestId('palette-action-menu')).toBeNull()
  })

  it('selecting "Copy page ULID" writes the page id to clipboard (PEND-67 Phase 5 expansion)', async () => {
    seedRecents()
    const writeText = vi.fn().mockResolvedValue(undefined)
    const orig = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    try {
      render(<CommandPalette />)
      openPalette()
      const recentRow = await screen.findByTestId('palette-recent-PAGE_R')
      recentRow.setAttribute('aria-selected', 'true')
      fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
      fireEvent.click(await screen.findByTestId('palette-action-copy-id'))
      expect(writeText).toHaveBeenCalledWith('PAGE_R')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: orig, configurable: true })
    }
  })

  it('selecting "Remove from recents" deletes the entry (PEND-67 Phase 5 expansion)', async () => {
    seedRecents()
    render(<CommandPalette />)
    openPalette()
    const recentRow = await screen.findByTestId('palette-recent-PAGE_R')
    recentRow.setAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
    fireEvent.click(await screen.findByTestId('palette-action-remove-from-recents'))
    const raw = localStorage.getItem('recent_pages:SPACE_TEST') ?? '[]'
    const parsed = JSON.parse(raw) as Array<{ id: string }>
    expect(parsed.length).toBe(0)
    // Action ran, menu closed; palette stays open (not a navigation).
    expect(useCommandPaletteStore.getState().open).toBe(true)
  })

  it('selecting "Reveal in Pages view" seeds the filter and flips the view (PEND-67 Phase 5 expansion)', async () => {
    seedRecents()
    render(<CommandPalette />)
    openPalette()
    const recentRow = await screen.findByTestId('palette-recent-PAGE_R')
    recentRow.setAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
    fireEvent.click(await screen.findByTestId('palette-action-reveal-in-pages'))
    expect(useNavigationStore.getState().pendingPageBrowserFilter).toBe('Recent')
    expect(useNavigationStore.getState().currentView).toBe('pages')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })

  it('block-row menu surfaces "Copy block link" with the Roam syntax (PEND-67 Phase 5 expansion)', async () => {
    mockedSearchBlocksPartitioned.mockResolvedValue(
      partitionedResp(
        [makePageRow('PAGE_X', 'Alpha')],
        [makeBlockRow('BLOCK_42', 'alpha note', 'PAGE_X', 'alpha <mark>note</mark>')],
      ),
    )
    const writeText = vi.fn().mockResolvedValue(undefined)
    const orig = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    try {
      render(<CommandPalette />)
      openPalette()
      fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'alpha' } })
      // Wait for the IPC to fire AND the search results to render before
      // looking for the block row — without this the findByTestId can
      // time out on a cold mock pipeline.
      await waitFor(() => {
        expect(mockedSearchBlocksPartitioned).toHaveBeenCalled()
      })
      const blockRow = await waitFor(() => screen.getByTestId('palette-block-BLOCK_42'), {
        timeout: 2000,
      })
      // Strip selection off any other row and set it on the block row so
      // the Tab handler picks the block as the focused target. cmdk
      // assigns aria-selected to the first item by default; we override
      // for this test.
      for (const item of document.querySelectorAll('[cmdk-item]')) {
        item.setAttribute('aria-selected', 'false')
      }
      blockRow.setAttribute('aria-selected', 'true')
      fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
      fireEvent.click(await screen.findByTestId('palette-action-copy-block-link'))
      expect(writeText).toHaveBeenCalledWith('((BLOCK_42))')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: orig, configurable: true })
    }
  })

  it('arrow-down inside the menu advances focus through the actions', async () => {
    seedRecents()
    render(<CommandPalette />)
    openPalette()
    const recentRow = await screen.findByTestId('palette-recent-PAGE_R')
    recentRow.setAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: 'Tab' })
    const menu = await screen.findByTestId('palette-action-menu')
    // First action is auto-focused on mount.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('palette-action-open'))
    })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByTestId('palette-action-open-new-tab'))
  })
})

describe('CommandPalette — partitioned query', () => {
  it('fires a single searchBlocksPartitioned call per keystroke', async () => {
    mockedSearchBlocksPartitioned.mockResolvedValue(
      partitionedResp(
        [makePageRow('PAGE_A', 'Alpha')],
        [makeBlockRow('B1', 'alpha mention', 'PAGE_A')],
      ),
    )

    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })

    await waitFor(() => {
      // Only ONE IPC per debounce window — the old design fired two
      // parallel calls; PEND-61 collapses them.
      expect(mockedSearchBlocksPartitioned).toHaveBeenCalled()
      const call = mockedSearchBlocksPartitioned.mock.calls.at(-1)?.[0]
      expect(call).toBeDefined()
      expect(call?.query).toBe('alpha')
      // The wrapper sets a page/block split with both partitions populated.
      expect(call?.pageLimit).toBeGreaterThan(0)
      expect(call?.blockLimit).toBeGreaterThan(0)
    })

    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
  })

  it('discards stale responses via the generation counter', async () => {
    // Use fake timers so we can manually drive both debounce windows —
    // without this, the second `fireEvent.change` simply replaces the
    // in-flight debounce and only ONE IPC fires.
    vi.useFakeTimers()

    let firstResolve: (v: PartitionedResp) => void = () => {}
    const firstPromise = new Promise<PartitionedResp>((resolve) => {
      firstResolve = resolve
    })
    mockedSearchBlocksPartitioned
      // First debounce window's call hangs on `firstPromise`, simulating
      // an in-flight backend that doesn't resolve before the user types
      // again.
      .mockImplementationOnce(() => firstPromise)
      // Subsequent calls resolve immediately to the fresh result set.
      .mockResolvedValue(partitionedResp([makePageRow('PAGE_FRESH', 'Fresh')], []))

    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')

    // Stale keystroke — flush the 80 ms debounce so the IPC fires
    // (hanging on `firstPromise`).
    fireEvent.change(input, { target: { value: 'stale' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    // Fresh keystroke — flush the 80 ms debounce so the second IPC
    // fires (resolving via `mockResolvedValue`).
    fireEvent.change(input, { target: { value: 'fresh' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    vi.useRealTimers()
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_FRESH')).toBeInTheDocument()
    })

    // Release the stale promise late — its response carries the older
    // generation counter and must NOT appear in the UI.
    await act(async () => {
      firstResolve(partitionedResp([makePageRow('PAGE_STALE', 'Stale')], []))
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(screen.queryByTestId('palette-page-header-PAGE_STALE')).toBeNull()
  })

  it('does not repopulate stale results after the input is cleared mid-flight (#736)', async () => {
    // The empty-query early-return must bump the generation guard and
    // drop `loading`: clearing the input does NOT fire a new IPC, so
    // without the bump the previous keystroke's in-flight response still
    // passes `isCurrent` and repopulates results UNDER the recents /
    // welcome empty state.
    vi.useFakeTimers()

    let firstResolve: (v: PartitionedResp) => void = () => {}
    const firstPromise = new Promise<PartitionedResp>((resolve) => {
      firstResolve = resolve
    })
    mockedSearchBlocksPartitioned.mockImplementationOnce(() => firstPromise)

    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')

    // Keystroke — flush the 80 ms debounce so the IPC fires (hanging).
    fireEvent.change(input, { target: { value: 'stale' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(mockedSearchBlocksPartitioned).toHaveBeenCalledTimes(1)
    // The hung IPC keeps the loading shimmer up…
    expect(screen.getByTestId('palette-loading-shimmer')).toBeInTheDocument()

    // …until the user clears the input mid-flight: the empty-query path
    // is synchronous (no debounce), clears results, and must drop the
    // shimmer immediately.
    fireEvent.change(input, { target: { value: '' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    vi.useRealTimers()
    expect(screen.queryByTestId('palette-loading-shimmer')).toBeNull()

    // The cleared keystroke fired no new IPC.
    expect(mockedSearchBlocksPartitioned).toHaveBeenCalledTimes(1)

    // Release the in-flight response late — its generation was
    // invalidated by the clear, so it must NOT repopulate the list.
    await act(async () => {
      firstResolve(partitionedResp([makePageRow('PAGE_STALE', 'Stale')], []))
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(screen.queryByTestId('palette-page-header-PAGE_STALE')).toBeNull()
    expect(screen.queryByTestId('palette-loading-shimmer')).toBeNull()
  })

  it('does not repopulate stale results after a mid-flight mode switch (#736)', async () => {
    // Same race, different exit: leaving search mode (mode chip / `>`
    // prefix) fires no new IPC either, so the `mode !== 'search'`
    // early-return must also bump the generation guard. Without it the
    // in-flight response lands silently while the commands body is
    // shown, then flashes as stale groups when the user toggles back
    // to search.
    vi.useFakeTimers()

    let firstResolve: (v: PartitionedResp) => void = () => {}
    const firstPromise = new Promise<PartitionedResp>((resolve) => {
      firstResolve = resolve
    })
    mockedSearchBlocksPartitioned.mockImplementationOnce(() => firstPromise)

    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')

    // Keystroke — flush the 80 ms debounce so the IPC fires (hanging).
    fireEvent.change(input, { target: { value: 'stale' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(mockedSearchBlocksPartitioned).toHaveBeenCalledTimes(1)

    // Toggle to commands mode mid-flight (no new search IPC fires)…
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    // …and let the in-flight response land while the commands body is
    // shown. Its generation was invalidated by the mode switch, so it
    // must NOT update pages/blocks behind the commands view.
    await act(async () => {
      firstResolve(partitionedResp([makePageRow('PAGE_STALE', 'Stale')], []))
      await vi.advanceTimersByTimeAsync(10)
    })

    // Toggling back to search must not flash the stale group — assert
    // BEFORE flushing the debounce, i.e. before any new fetch could
    // overwrite a (buggy) stale repopulation.
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    expect(screen.queryByTestId('palette-page-header-PAGE_STALE')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    vi.useRealTimers()
    expect(screen.queryByTestId('palette-page-header-PAGE_STALE')).toBeNull()
  })
})

describe('CommandPalette — caps and surplus pill', () => {
  it('caps groups at 8 and matches per group at 2', () => {
    // Use the pure helper so we don't have to drive 12 simultaneous
    // FTS-mock responses. The cap logic is the same as what the
    // component invokes per render.
    const pages = Array.from({ length: 12 }).map((_, i) => makePageRow(`PAGE_${i}`, `Page ${i}`))
    const blocks: SearchRow[] = []
    for (let i = 0; i < 12; i++) {
      // Three matches per page → cap to 2 + surplus 1.
      blocks.push(
        makeBlockRow(`B${i}_0`, 'm0', `PAGE_${i}`),
        makeBlockRow(`B${i}_1`, 'm1', `PAGE_${i}`),
        makeBlockRow(`B${i}_2`, 'm2', `PAGE_${i}`),
      )
    }
    const groups = mergeAndRankGroups(pages, blocks, 'page')
    expect(groups.length).toBe(8)
    for (const g of groups) {
      expect(g.matches.length).toBeLessThanOrEqual(2)
      expect(g.surplus).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('CommandPalette — keyboard navigation', () => {
  it('Enter fires navigateToPage on the first result (cmdk owns the active descendant)', async () => {
    // cmdk owns the `aria-activedescendant` value and updates it as
    // the user arrows through the list. We don't pin a specific
    // descendant id (that's an implementation detail of cmdk); instead
    // we verify the side effect: Enter triggers `navigateToPage` with
    // the highlighted item's args. The first item is auto-selected by
    // cmdk on render.
    const navigateToPage = vi.fn()
    useTabsStore.setState({ navigateToPage })
    mockedSearchBlocksPartitioned.mockResolvedValue(
      partitionedResp([makePageRow('PAGE_A', 'Alpha'), makePageRow('PAGE_B', 'Bravo')], []),
    )
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'pages' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
      expect(screen.getByTestId('palette-page-header-PAGE_B')).toBeInTheDocument()
    })
    await userEvent.keyboard('{Enter}')
    expect(navigateToPage).toHaveBeenCalledTimes(1)
    // First item is auto-highlighted; arrow nav is cmdk-owned but we
    // don't assert the specific order here (the 4-band ranking ties
    // Alpha + Bravo at the same score and either may sort first).
    const call = navigateToPage.mock.calls[0]
    if (call == null) throw new Error('navigateToPage was not called')
    const [pageId, title] = call
    expect(['PAGE_A', 'PAGE_B']).toContain(pageId)
    expect(['Alpha', 'Bravo']).toContain(title)
  })
})

describe('CommandPalette — click semantics', () => {
  it('plain Enter navigates the active tab', async () => {
    const navigateToPage = vi.fn()
    useTabsStore.setState({ navigateToPage })
    mockedSearchBlocksPartitioned.mockResolvedValue(
      partitionedResp([makePageRow('PAGE_A', 'Alpha')], []),
    )
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    await userEvent.keyboard('{Enter}')
    expect(navigateToPage).toHaveBeenCalledWith('PAGE_A', 'Alpha')
  })

  it('Cmd/Ctrl+Enter opens in a new tab', async () => {
    const navigateToPage = vi.fn()
    const openInNewTab = vi.fn()
    useTabsStore.setState({ navigateToPage, openInNewTab })
    mockedSearchBlocksPartitioned.mockResolvedValue(
      partitionedResp([makePageRow('PAGE_A', 'Alpha')], []),
    )
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    // The component's new-tab detector lives on the `<CommandList>` /
    // `<CommandInput>` wrappers (cmdk's `onSelect` doesn't expose
    // modifier keys). Firing keyDown on the input bubbles up through
    // the wrapper handler before cmdk's internal Enter handler fires.
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(openInNewTab).toHaveBeenCalledWith('PAGE_A', 'Alpha')
    expect(navigateToPage).not.toHaveBeenCalled()
  })
})

describe('CommandPalette — escalation footer', () => {
  it('hands off pendingViewQuery and flips the view', async () => {
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'escalate' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-escalation-footer')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('palette-escalation-footer'))
    expect(useCommandPaletteStore.getState().pendingViewQuery).toBe('escalate')
    expect(useNavigationStore.getState().currentView).toBe('search')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────
// PEND-58g UX-A1 — mobile "Filters & regex" escalation CTA
// ───────────────────────────────────────────────────────────────────

describe('CommandPalette — mobile escalation CTA (PEND-58g UX-A1)', () => {
  it('renders the always-visible CTA in the all-pages sheet with an EMPTY query', async () => {
    mockedUseIsMobile.mockReturnValue(true)
    render(<CommandPalette />)
    openPalette()
    // No keystroke — the query is empty (cold open). The CTA must
    // still surface so touch users discover filters / regex / history.
    const cta = await screen.findByTestId('palette-escalation-footer')
    expect(cta).toBeInTheDocument()
    expect(screen.getByText('Filters & regex')).toBeInTheDocument()
    expect(screen.getByText('Open full search')).toBeInTheDocument()
    expect(cta).toHaveAttribute('aria-label', 'Open full search for filters, regex, and history')
  })

  it('tapping the CTA hands off the (possibly empty) query, flips the view, and closes', async () => {
    mockedUseIsMobile.mockReturnValue(true)
    const user = userEvent.setup()
    render(<CommandPalette />)
    openPalette()
    const cta = await screen.findByTestId('palette-escalation-footer')
    await user.click(cta)
    expect(useCommandPaletteStore.getState().pendingViewQuery).toBe('')
    expect(useNavigationStore.getState().currentView).toBe('search')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })

  it('forwards a typed query when the CTA is tapped on mobile', async () => {
    mockedUseIsMobile.mockReturnValue(true)
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'todo' } })
    const cta = await screen.findByTestId('palette-escalation-footer')
    fireEvent.click(cta)
    expect(useCommandPaletteStore.getState().pendingViewQuery).toBe('todo')
    expect(useNavigationStore.getState().currentView).toBe('search')
  })

  it('does NOT leak the mobile CTA onto desktop — the inline footer stays query-gated', async () => {
    // Desktop default (useIsMobile=false). With an empty query there is
    // no escalation affordance at all; the inline cmdk footer only
    // appears once a query yields results / a no-results state.
    render(<CommandPalette />)
    openPalette()
    expect(screen.queryByTestId('palette-escalation-footer')).toBeNull()
    expect(screen.queryByText('Filters & regex')).toBeNull()
    // Type a query → the desktop inline footer (the muted cmdk row,
    // NOT the mobile two-line box) appears.
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'escalate' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-escalation-footer')).toBeInTheDocument()
    })
    // The desktop footer never renders the mobile CTA title/hint.
    expect(screen.queryByText('Filters & regex')).toBeNull()
    expect(screen.queryByText('Open full search')).toBeNull()
  })

  it('passes a vitest-axe scan with the mobile CTA rendered (empty query)', async () => {
    mockedUseIsMobile.mockReturnValue(true)
    const { container } = render(<CommandPalette />)
    openPalette()
    await screen.findByTestId('palette-escalation-footer')
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

describe('CommandPalette — [[page]] autocomplete', () => {
  it('fires a single partitioned IPC with blockLimit=0 in link mode (PEND-69 two-scan guarantees page coverage)', async () => {
    // PEND-69 F1 — the partitioned IPC now runs two parallel SQL
    // scans (page-only + unrestricted) each with its own `limit + 1`
    // probe, so the pages partition is guaranteed to surface matching
    // pages regardless of content-row rank. Link mode no longer needs
    // a dedicated `searchBlocks({blockTypeFilter: 'page'})` round-trip
    // — it asks for zero blocks and reads the pages partition.
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: '[[a' } })
    expect(screen.getByTestId('palette-link-mode-badge')).toBeInTheDocument()
    await waitFor(() => {
      const calls = mockedSearchBlocksPartitioned.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call[0].blockLimit).toBe(0)
      }
      // The legacy page-only searchBlocks workaround must NOT fire.
      expect(mockedSearchBlocks).not.toHaveBeenCalled()
    })
  })

  it('surfaces a "no page matches" hint when the query has no hits', async () => {
    mockedSearchBlocks.mockResolvedValue({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: '[[unknown' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-no-link-match')).toBeInTheDocument()
    })
  })

  const mockPageA = () =>
    mockedSearchBlocksPartitioned.mockResolvedValue({
      pages: {
        items: [makePageRow('PAGE_A', 'Alpha')],
        next_cursor: null,
        has_more: false,
        total_count: null,
      },
      blocks: { items: [], next_cursor: null, has_more: false, total_count: null },
    })

  it('inserts [[Page Title]] into a TipTap block via the editor command (#82, undo-safe)', async () => {
    // The block editor renders inside a `.ProseMirror` node. #82 routes
    // that case through the active-editor registry + `insertContent` so
    // the insert joins the undo history (replacing the deprecated
    // `execCommand`). We register a fluent-chain mock and assert it is
    // driven with the link payload.
    const chainCalls = { focus: vi.fn(), insertContent: vi.fn(), run: vi.fn() }
    // oxlint-disable-next-line typescript/no-explicit-any -- minimal fluent chain stub.
    const chainObj: any = {
      focus: (...a: unknown[]) => {
        chainCalls.focus(...a)
        return chainObj
      },
      insertContent: (...a: unknown[]) => {
        chainCalls.insertContent(...a)
        return chainObj
      },
      run: (...a: unknown[]) => {
        chainCalls.run(...a)
        return true
      },
    }
    setActiveEditor({ chain: () => chainObj } as unknown as Editor)

    // A `.ProseMirror` contenteditable host stands in for the focused block.
    const pm = document.createElement('div')
    pm.className = 'ProseMirror'
    pm.contentEditable = 'true'
    document.body.appendChild(pm)
    pm.focus()

    mockPageA()
    openPalette()
    render(<CommandPalette />)
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '[[a' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    await userEvent.keyboard('{Enter}')

    expect(chainCalls.focus).toHaveBeenCalled()
    expect(chainCalls.insertContent).toHaveBeenCalledWith('[[Alpha]]')
    expect(chainCalls.run).toHaveBeenCalled()

    setActiveEditor(null)
    pm.remove()
  })

  it('inserts into a non-TipTap contenteditable via the Selection/Range fallback (#82 Path A)', async () => {
    // No active editor + not a `.ProseMirror` node → the forward-compatible
    // Selection/Range fallback (undo loss accepted, documented in #82).
    setActiveEditor(null)
    const host = document.createElement('div')
    host.contentEditable = 'true'
    host.textContent = 'x'
    document.body.appendChild(host)
    host.focus()
    // Plant a collapsed caret at the end so the store snapshots a range
    // and the fallback has somewhere to insert.
    const range = document.createRange()
    range.selectNodeContents(host)
    range.collapse(false)
    const sel = document.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)

    mockPageA()
    openPalette()
    render(<CommandPalette />)
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '[[a' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    await userEvent.keyboard('{Enter}')

    expect(host.textContent).toContain('[[Alpha]]')
    host.remove()
  })

  it('inserts [[Page Title]] into a previously focused <input> (#82 native branch)', async () => {
    setActiveEditor(null)
    const field = document.createElement('input')
    field.type = 'text'
    field.value = 'pre '
    document.body.appendChild(field)
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)

    mockPageA()
    openPalette()
    render(<CommandPalette />)
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '[[a' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    await userEvent.keyboard('{Enter}')

    expect(field.value).toBe('pre [[Alpha]]')
    field.remove()
  })
})

describe('CommandPalette — commands mode', () => {
  it('switches store mode to "commands" when the user types ">"', async () => {
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    expect(useCommandPaletteStore.getState().mode).toBe('search')
    fireEvent.change(input, { target: { value: '>' } })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('commands')
    })
  })

  it('renders the mode chip in both modes and clicking it toggles modes', async () => {
    render(<CommandPalette />)
    openPalette()
    const chip = screen.getByTestId('palette-mode-chip')
    expect(chip).toBeInTheDocument()
    fireEvent.click(chip)
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('commands')
    })
    // Chip is still rendered in commands mode.
    expect(screen.getByTestId('palette-mode-chip')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('search')
    })
  })

  it('renders all 6 commands with navigate / action group containers', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-commands-navigate')).toBeInTheDocument()
    })
    expect(screen.getByTestId('palette-commands-action')).toBeInTheDocument()
    for (const id of [
      'go-pages',
      'go-tags',
      'go-trash',
      'go-history',
      'go-settings',
      'search-everywhere',
    ]) {
      expect(screen.getByTestId(`palette-cmd-${id}`)).toBeInTheDocument()
    }
  })

  it('selecting "go-settings" calls setView("settings") and closes the palette', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-go-settings')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('palette-cmd-go-settings'))
    expect(useNavigationStore.getState().currentView).toBe('settings')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })

  it('selecting "search-everywhere" seeds pendingViewQuery="" and flips the view to "search"', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-search-everywhere')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('palette-cmd-search-everywhere'))
    expect(useCommandPaletteStore.getState().pendingViewQuery).toBe('')
    expect(useNavigationStore.getState().currentView).toBe('search')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })
})

describe('CommandPalette — commands mode recent commands (PEND-67 Phase 2)', () => {
  it('does NOT render the Recent group on a cold open with no run history', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-commands-navigate')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('palette-commands-recent')).toBeNull()
  })

  it('records run history under the active space and surfaces it on re-open', async () => {
    // Seed: act as if go-settings was previously run in SPACE_TEST.
    localStorage.setItem(
      'recent_commands:SPACE_TEST',
      JSON.stringify([{ id: 'go-settings', runAt: '2026-05-19T00:00:00Z' }]),
    )
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-commands-recent')).toBeInTheDocument()
    })
    expect(screen.getByTestId('palette-cmd-recent-go-settings')).toBeInTheDocument()
  })

  it('hides the Recent group while the user is filtering (non-empty input)', async () => {
    localStorage.setItem(
      'recent_commands:SPACE_TEST',
      JSON.stringify([{ id: 'go-settings', runAt: '2026-05-19T00:00:00Z' }]),
    )
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-commands-recent')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'tag' } })
    await waitFor(() => {
      expect(screen.queryByTestId('palette-commands-recent')).toBeNull()
    })
  })

  it('writes to the active-space slot when a command runs', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-go-tags')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('palette-cmd-go-tags'))
    const raw = localStorage.getItem('recent_commands:SPACE_TEST') ?? '[]'
    const parsed = JSON.parse(raw) as Array<{ id: string }>
    expect(parsed[0]?.id).toBe('go-tags')
  })

  it('preserves the search query when chip-toggling to commands and back (PEND-67 Phase 6)', async () => {
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'alpha' } })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().query).toBe('alpha')
    })

    // Toggle to commands — query slot for commands is empty.
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('commands')
    })
    expect(useCommandPaletteStore.getState().query).toBe('')

    // Type something in commands mode.
    fireEvent.change(input, { target: { value: 'set' } })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().query).toBe('set')
    })

    // Toggle back — search query restored, commands query preserved
    // in the per-mode slot.
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('search')
    })
    expect(useCommandPaletteStore.getState().query).toBe('alpha')

    // Toggle to commands again — its slot still has "set".
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('commands')
    })
    expect(useCommandPaletteStore.getState().query).toBe('set')
  })

  it('numeric prefix 1-9 jumps to the Nth visible item (PEND-67 Phase 7)', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-go-pages')).toBeInTheDocument()
    })
    // The first visible cmdk-item with no recents is go-pages.
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: '1' })
    expect(useNavigationStore.getState().currentView).toBe('pages')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })

  it('numeric prefix is ignored when the input has content (PEND-67 Phase 7)', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    const input = screen.getByTestId('command-palette-input') as HTMLInputElement
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-go-pages')).toBeInTheDocument()
    })
    // Type something first → the digit guard no longer triggers, so
    // pressing "2" must NOT close the palette or call setView.
    fireEvent.change(input, { target: { value: 'tag' } })
    const navBefore = useNavigationStore.getState().currentView
    fireEvent.keyDown(input, { key: '2' })
    // No view change, palette still open.
    expect(useNavigationStore.getState().currentView).toBe(navBefore)
    expect(useCommandPaletteStore.getState().open).toBe(true)
  })

  it('numeric prefix 0 does nothing (PEND-67 Phase 7)', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-go-pages')).toBeInTheDocument()
    })
    const navBefore = useNavigationStore.getState().currentView
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), { key: '0' })
    expect(useNavigationStore.getState().currentView).toBe(navBefore)
    expect(useCommandPaletteStore.getState().open).toBe(true)
  })

  it('typing `#alpha` flips to tags mode, strips prefix, fires IPC (PEND-67 Phase 3)', async () => {
    mockedSearchBlocks.mockResolvedValue({
      items: [makePageRow('TAG_ALPHA', 'alpha')],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: '#alpha' } })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('tags')
    })
    expect(useCommandPaletteStore.getState().query).toBe('alpha')
    await waitFor(() => {
      const call = mockedSearchBlocks.mock.calls.at(-1)?.[0]
      expect(call?.query).toBe('alpha')
      expect(call?.blockTypeFilter).toBe('tag')
    })
  })

  it('selecting a tag escalates with `tag:#<name>` to the search view (PEND-67 Phase 3)', async () => {
    mockedSearchBlocks.mockResolvedValue({
      items: [makePageRow('TAG_URGENT', 'urgent')],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    render(<CommandPalette />)
    openPalette()
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '#u' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-tag-TAG_URGENT')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('palette-tag-TAG_URGENT'))
    expect(useCommandPaletteStore.getState().pendingViewQuery).toBe('tag:#urgent')
    expect(useNavigationStore.getState().currentView).toBe('search')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })

  it('typing `?` flips to help mode and renders the shortcut catalog (PEND-67 Phase 3)', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '?' } })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('help')
    })
    // `focusSearch` is one of the seeded catalog ids and should render.
    expect(screen.getByTestId('palette-help-focusSearch')).toBeInTheDocument()
  })

  it('help mode filters by description text (PEND-67 Phase 3)', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.change(screen.getByTestId('command-palette-input'), {
      target: { value: '?palette' },
    })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('help')
    })
    expect(useCommandPaletteStore.getState().query).toBe('palette')
    // `paletteOpen` (description "Open quick search palette") survives.
    expect(screen.getByTestId('palette-help-paletteOpen')).toBeInTheDocument()
    // `focusSearch` (description "Search across all pages") does not.
    expect(screen.queryByTestId('palette-help-focusSearch')).toBeNull()
  })

  it('mode chip returns to search from tags / help in one click (PEND-67 Phase 3)', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: '?' } })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('help')
    })
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    expect(useCommandPaletteStore.getState().mode).toBe('search')
  })

  it('numeric prefix is ignored with modifier keys (PEND-67 Phase 7)', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-go-pages')).toBeInTheDocument()
    })
    const navBefore = useNavigationStore.getState().currentView
    fireEvent.keyDown(screen.getByTestId('command-palette-input'), {
      key: '1',
      ctrlKey: true,
    })
    // Modifier-decorated digits stay free for OS / browser handlers.
    expect(useNavigationStore.getState().currentView).toBe(navBefore)
    expect(useCommandPaletteStore.getState().open).toBe(true)
  })

  it('does not loop when the `>` prefix routes to commands mode (PEND-67 Phase 6)', async () => {
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')

    // Typing `>set` flips to commands mode with stripped query "set"
    // AND clears the search slot so chip-toggle back does not re-fire
    // the mode router.
    fireEvent.change(input, { target: { value: '>set' } })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('commands')
    })
    expect(useCommandPaletteStore.getState().query).toBe('set')

    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('search')
    })
    // Search slot is empty — no `>set` leftover, no router loop.
    expect(useCommandPaletteStore.getState().query).toBe('')
  })

  it('renders an inline shortcut chip for commands with a shortcutId (PEND-67 Phase 1)', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-search-everywhere')).toBeInTheDocument()
    })
    // search-everywhere is wired to `focusSearch` (Ctrl+Shift+F) → 3 tokens.
    const chips = screen.getByTestId('palette-cmd-shortcut-focusSearch')
    expect(chips).toBeInTheDocument()
    const kbds = chips.querySelectorAll('kbd')
    expect(kbds.length).toBe(3)
    // Modifiers map to glyphs; the letter stays uppercase.
    const labels = Array.from(kbds).map((k) => k.textContent)
    expect(labels).toEqual(['⌃', '⇧', 'F'])
  })

  it('omits the chord chip for commands without a shortcutId', async () => {
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-go-pages')).toBeInTheDocument()
    })
    // go-pages has no shortcutId — no chord chip should render.
    expect(screen.queryByTestId('palette-cmd-shortcut-go-pages')).toBeNull()
  })

  it('picks up a rebound shortcut on the next render (PEND-67 Phase 1)', async () => {
    // Seed an override BEFORE the palette opens — `getShortcutKeys`
    // reads localStorage on every call, so a rebind takes effect on
    // the next render without forcing a remount.
    localStorage.setItem(
      'agaric-keyboard-shortcuts',
      JSON.stringify({ focusSearch: 'Ctrl + Alt + K' }),
    )
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-shortcut-focusSearch')).toBeInTheDocument()
    })
    const labels = Array.from(
      screen.getByTestId('palette-cmd-shortcut-focusSearch').querySelectorAll('kbd'),
    ).map((k) => k.textContent)
    expect(labels).toEqual(['⌃', '⌥', 'K'])
  })

  it('silently skips stale command ids that no longer exist in the registry', async () => {
    localStorage.setItem(
      'recent_commands:SPACE_TEST',
      JSON.stringify([
        { id: 'go-vanished', runAt: '2026-05-19T00:00:00Z' },
        { id: 'go-pages', runAt: '2026-05-19T00:01:00Z' },
      ]),
    )
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-commands-recent')).toBeInTheDocument()
    })
    expect(screen.getByTestId('palette-cmd-recent-go-pages')).toBeInTheDocument()
    expect(screen.queryByTestId('palette-cmd-recent-go-vanished')).toBeNull()
  })
})

describe('CommandPalette — a11y', () => {
  it('does not crash when searchBlocksPartitioned rejects', async () => {
    // IPC error-path coverage per AGENTS.md:198 — the palette must
    // survive a rejected partitioned call without throwing or leaking
    // a console error. The empty state should render (no page-group,
    // no error toast within the palette).
    mockedSearchBlocksPartitioned.mockRejectedValue(new Error('Database busy'))
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })
    // The rejection resolves; the palette should render no result
    // groups and stay open without crashing.
    await waitFor(() => {
      expect(screen.queryByTestId('palette-page-header-PAGE_A')).toBeNull()
    })
    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument()
  })

  it('passes a vitest-axe scan with search-mode results rendered', async () => {
    mockedSearchBlocksPartitioned.mockResolvedValue(
      partitionedResp([makePageRow('PAGE_A', 'Alpha')], []),
    )
    const { container } = render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('passes a vitest-axe scan in commands mode', async () => {
    const { container } = render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-commands-navigate')).toBeInTheDocument()
    })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})

// ───────────────────────────────────────────────────────────────────
// PEND-72 — external-query sync (search-sheet bridge seed)
// ───────────────────────────────────────────────────────────────────

describe('CommandPalette — PEND-72 external query sync', () => {
  it('fires the IPC immediately when the store query is set externally', async () => {
    // Simulates the mobile search sheet seeding the palette on
    // segment switch: write to the store AFTER PaletteBody mounts,
    // and expect the partitioned IPC to fire without a user keystroke.
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('command-palette-input')).toBeInTheDocument()
    mockedSearchBlocksPartitioned.mockClear()
    act(() => {
      useCommandPaletteStore.getState().setQuery('seedme')
    })
    await waitFor(() => {
      expect(mockedSearchBlocksPartitioned).toHaveBeenCalled()
      const firstCall = mockedSearchBlocksPartitioned.mock.calls[0]?.[0]
      expect(firstCall?.query).toBe('seedme')
    })
  })

  it('respects the 80 ms debounce for user typing (no immediate fire per keystroke)', async () => {
    // PEND-72 sync effect must NOT short-circuit the debounce when
    // changes come from the input. Type three characters synchronously
    // via fireEvent; without the lastUserQueryRef guard the sync
    // effect would fire setDebouncedQuery on every render and bypass
    // the debounce entirely. With the guard, only the final
    // debounced value fires the IPC after the timer elapses.
    vi.useFakeTimers()
    try {
      render(<CommandPalette />)
      openPalette()
      const input = screen.getByTestId('command-palette-input')
      mockedSearchBlocksPartitioned.mockClear()
      fireEvent.change(input, { target: { value: 'a' } })
      fireEvent.change(input, { target: { value: 'ab' } })
      fireEvent.change(input, { target: { value: 'abc' } })
      // Before the debounce timer fires, no IPC should have run.
      expect(mockedSearchBlocksPartitioned).not.toHaveBeenCalled()
      // Advance past the 80 ms debounce.
      act(() => {
        vi.advanceTimersByTime(200)
      })
      // Exactly one IPC fires, with the final value.
      expect(mockedSearchBlocksPartitioned).toHaveBeenCalledTimes(1)
      const firstCall = mockedSearchBlocksPartitioned.mock.calls[0]?.[0]
      expect(firstCall?.query).toBe('abc')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ───────────────────────────────────────────────────────────────────
// PEND-61 CR regression tests
// ───────────────────────────────────────────────────────────────────

describe('CommandPalette — PEND-61 CR regressions', () => {
  it('linkMode page-only guarantee — page surfaces even when many content rows outrank it', async () => {
    // PEND-69 F1 — the partitioned IPC's two-scan shape guarantees
    // per-partition page coverage. linkMode now uses the same IPC
    // with `blockLimit: 0`; the pages partition is filled by the
    // dedicated page-only SQL scan, independent of content-row rank.
    mockedSearchBlocksPartitioned.mockResolvedValue({
      pages: {
        items: [makePageRow('PAGE_LINK', 'Linkable')],
        next_cursor: null,
        has_more: false,
        total_count: null,
      },
      blocks: {
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      },
    })
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: '[[link' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_LINK')).toBeInTheDocument()
    })
    // linkMode asks for zero blocks so the IPC short-circuits the
    // unrestricted scan.
    const call = mockedSearchBlocksPartitioned.mock.calls.at(-1)?.[0]
    expect(call?.blockLimit).toBe(0)
  })

  it('cold-open [[page]] Enter falls through to plain navigation when no editor focus was captured', async () => {
    // PEND-61 CR (UX-must-3): cold-open `[[page]]` (no previously
    // focused element) used to silently close. Fall through to
    // `navigateToPage` so the user gets something.
    const navigateToPage = vi.fn()
    useTabsStore.setState({ navigateToPage })
    // PEND-69 F1 — linkMode now uses the partitioned IPC (blockLimit=0).
    mockedSearchBlocksPartitioned.mockResolvedValue({
      pages: {
        items: [makePageRow('PAGE_X', 'Xenial')],
        next_cursor: null,
        has_more: false,
        total_count: null,
      },
      blocks: {
        items: [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      },
    })
    render(<CommandPalette />)
    // openPalette() opens with `document.activeElement === <body>`, so
    // previousFocusedElement is null — the cold-open case.
    openPalette()
    expect(useCommandPaletteStore.getState().previousFocusedElement).toBeNull()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: '[[xen' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_X')).toBeInTheDocument()
    })
    await userEvent.keyboard('{Enter}')
    expect(navigateToPage).toHaveBeenCalledWith('PAGE_X', 'Xenial')
    expect(useCommandPaletteStore.getState().open).toBe(false)
  })

  it('shows a welcome empty copy on cold open with no recents', () => {
    // PEND-61 CR (UX-should-5): the welcome state has its own copy
    // distinct from the no-results-for-typed-query state.
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('palette-welcome-empty')).toBeInTheDocument()
  })

  it('shows a "no results for query" copy when the typed query has zero matches', async () => {
    // PEND-61 CR (UX-should-2): typed query → empty partitions →
    // dedicated copy (not the generic welcome message).
    mockedSearchBlocksPartitioned.mockResolvedValue({
      pages: emptyPartition(),
      blocks: emptyPartition(),
    })
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'nothingmatches' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-no-results')).toBeInTheDocument()
    })
  })

  it('mode chip click flips mode WITHOUT writing a literal "> " into the input', async () => {
    // PEND-61 CR (UX-should-6): toggling via the chip used to fake-
    // type `'> '` into the user-visible input. The mode flag is
    // authoritative now; the prefix is only an entry shortcut.
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('commands')
    })
    // Input is clean — no leading ">" or space.
    expect(useCommandPaletteStore.getState().query).toBe('')
  })

  it('renders the footer hint with new-tab affordance copy in search mode', () => {
    // PEND-61 CR (UX-should-3): the new footer hint surfaces the
    // ⌘↵ new-tab affordance + ↵ + esc shortcuts.
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('palette-footer-hint')).toBeInTheDocument()
  })

  // ─────────────────────────────────────────────────────────────────
  // PEND-61 CR-2 regressions
  // ─────────────────────────────────────────────────────────────────

  it('commands-mode filter does NOT double-strip ">" — typing ">set" matches go-settings', async () => {
    // PEND-61 CR-2 (tech-must-1): the mode router already strips the
    // leading ">" from the store query when typed as the entry
    // shortcut, so CommandsModeBody must filter by `query` directly
    // (not `commandsModeQuery(query)`). Previously typing `>set`
    // filtered as `et` and missed `go-settings`.
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: '>set' } })
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('commands')
    })
    // `go-settings` is the only command whose label contains "set"
    // (case-insensitive). It must render.
    expect(screen.getByTestId('palette-cmd-go-settings')).toBeInTheDocument()
  })

  it('Backspace on empty input in commands mode returns to search mode', async () => {
    // PEND-61 CR-2 (UX-should-3): VSCode's Cmd+P ↔ Cmd+Shift+P
    // parity. Empty input + Backspace in commands mode flips back
    // to search so the user has a keyboard-only return path.
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().mode).toBe('commands')
    })
    expect(useCommandPaletteStore.getState().query).toBe('')
    const input = screen.getByTestId('command-palette-input')
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(useCommandPaletteStore.getState().mode).toBe('search')
  })

  it('renders the loading status (sr-only) while the IPC is in flight', async () => {
    // PEND-61 CR-2 (UX-should-9): visible loading affordance during
    // the debounce → IPC window. The shimmer is decorative; SR users
    // get the polite live-region announcement.
    let resolve: (v: Awaited<ReturnType<typeof searchBlocksPartitioned>>) => void = () => {}
    mockedSearchBlocksPartitioned.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof searchBlocksPartitioned>>>((r) => {
          resolve = r
        }),
    )
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'pending' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-loading-status')).toHaveTextContent('Searching…')
      expect(screen.getByTestId('palette-loading-shimmer')).toBeInTheDocument()
    })
    // Resolve the IPC; the loading affordance clears.
    resolve(partitionedResp([], []))
    await waitFor(() => {
      expect(screen.getByTestId('palette-loading-status')).toHaveTextContent('')
      expect(screen.queryByTestId('palette-loading-shimmer')).toBeNull()
    })
  })

  it('command-mode rows render a leading Lucide icon (not plain text)', async () => {
    // PEND-61 CR-2 (UX-should-2): every command row carries a leading
    // glyph so power-user scan-ability matches Raycast/Linear. We
    // verify the SVG presence inside the CommandItem rather than
    // pinning a specific icon (which would couple the test to
    // copy-tweaks).
    render(<CommandPalette />)
    openPalette()
    fireEvent.click(screen.getByTestId('palette-mode-chip'))
    await waitFor(() => {
      expect(screen.getByTestId('palette-cmd-go-settings')).toBeInTheDocument()
    })
    const row = screen.getByTestId('palette-cmd-go-settings')
    expect(row.querySelector('svg')).not.toBeNull()
  })

  it('page-header row renders Lucide FileText (not the legacy 📄 emoji)', async () => {
    mockedSearchBlocksPartitioned.mockResolvedValue(
      partitionedResp([makePageRow('PAGE_ICON', 'Iconic')], []),
    )
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'icon' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_ICON')).toBeInTheDocument()
    })
    const row = screen.getByTestId('palette-page-header-PAGE_ICON')
    expect(row.querySelector('svg')).not.toBeNull()
    expect(row.textContent ?? '').not.toContain('📄')
  })

  it('title-match signal renders as a pill (data-testid) when the page name matches', async () => {
    mockedSearchBlocksPartitioned.mockResolvedValue(
      partitionedResp([makePageRow('PAGE_PILL', 'Pillbox')], []),
    )
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: 'pill' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-title-match-tag')).toBeInTheDocument()
    })
  })
})
