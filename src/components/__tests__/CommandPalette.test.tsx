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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { useNavigationStore } from '../../stores/navigation'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import { useCommandPaletteStore } from '../../stores/useCommandPaletteStore'
import { CommandPalette, mergeAndRankGroups } from '../CommandPalette'

// Mock the partitioned IPC so we can drive its responses deterministically
// from tests. Spread the actual module so other re-exports (paginationLimit,
// etc.) stay intact.
vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    // PEND-61 CR — linkMode now fires `searchBlocks({blockTypeFilter:
    // 'page'})` for the page-only guarantee; non-linkMode still fires
    // `searchBlocksPartitioned`. Both must be mocked.
    searchBlocks: vi.fn(),
    searchBlocksPartitioned: vi.fn(),
  }
})

import { searchBlocks, searchBlocksPartitioned } from '../../lib/tauri'

const mockedSearchBlocksPartitioned = vi.mocked(searchBlocksPartitioned)
const mockedSearchBlocks = vi.mocked(searchBlocks)

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

describe('CommandPalette — [[page]] autocomplete', () => {
  it('fires a page-only searchBlocks call in link mode (NOT the partitioned IPC)', async () => {
    // PEND-61 CR — the partitioned IPC's combined fetch cap can drown
    // the pages partition when content rows outrank pages. Link mode
    // therefore uses a dedicated `searchBlocks({blockTypeFilter:
    // 'page'})` call for the page-only guarantee.
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: '[[a' } })
    expect(screen.getByTestId('palette-link-mode-badge')).toBeInTheDocument()
    await waitFor(() => {
      const calls = mockedSearchBlocks.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call[0].blockTypeFilter).toBe('page')
      }
      // Partitioned IPC must NOT have fired in link mode.
      expect(mockedSearchBlocksPartitioned).not.toHaveBeenCalled()
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

  it('inserts [[Page Title]] into the previously focused contenteditable on Enter', async () => {
    // jsdom doesn't implement `document.execCommand`. Stub it before
    // the store opens — the palette only checks
    // `target.isContentEditable` and then calls
    // `execCommand('insertText', ...)`. We capture the call so the
    // assertion can verify the link payload.
    const execCommandStub = vi
      .fn()
      .mockImplementation((_cmd: string, _ui?: boolean | undefined, value?: string) => {
        host.textContent = `${host.textContent ?? ''}${value ?? ''}`
        return true
      })
    // biome-ignore lint/suspicious/noExplicitAny: jsdom's Document prototype omits execCommand — assigning via `as any` is the cleanest test-only stub.
    ;(document as any).execCommand = execCommandStub

    // Set up a contenteditable host to act as the editor block.
    const host = document.createElement('div')
    host.contentEditable = 'true'
    host.textContent = ''
    document.body.appendChild(host)
    host.focus()

    // PEND-61 CR — linkMode uses the dedicated page-only
    // searchBlocks IPC; mock that one (not the partitioned variant).
    mockedSearchBlocks.mockResolvedValue({
      items: [makePageRow('PAGE_A', 'Alpha')],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    // Capture focus before opening — the store snapshots
    // `document.activeElement` on open$.
    openPalette()
    render(<CommandPalette />)
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: '[[a' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    await userEvent.keyboard('{Enter}')
    expect(execCommandStub).toHaveBeenCalledWith('insertText', false, '[[Alpha]]')
    host.remove()
    // biome-ignore lint/suspicious/noExplicitAny: restore the jsdom-default missing property.
    ;(document as any).execCommand = undefined
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
// PEND-61 CR regression tests
// ───────────────────────────────────────────────────────────────────

describe('CommandPalette — PEND-61 CR regressions', () => {
  it('linkMode page-only guarantee — page surfaces even when many content rows outrank it', async () => {
    // PEND-61 CR (tech-must-1): the partitioned IPC's combined fetch
    // cap could drown the pages partition. linkMode now uses a
    // dedicated `searchBlocks({blockTypeFilter:'page'})` to preserve
    // the page-only guarantee. Verify the page-typed row reaches the
    // DOM even if we don't seed any content rows (the real-world
    // failure case wouldn't reach us anyway since we no longer ask
    // for content rows).
    mockedSearchBlocks.mockResolvedValue({
      items: [makePageRow('PAGE_LINK', 'Linkable')],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    fireEvent.change(input, { target: { value: '[[link' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_LINK')).toBeInTheDocument()
    })
    // The dedicated page-only call carries the right filter.
    const call = mockedSearchBlocks.mock.calls.at(-1)?.[0]
    expect(call?.blockTypeFilter).toBe('page')
  })

  it('cold-open [[page]] Enter falls through to plain navigation when no editor focus was captured', async () => {
    // PEND-61 CR (UX-must-3): cold-open `[[page]]` (no previously
    // focused element) used to silently close. Fall through to
    // `navigateToPage` so the user gets something.
    const navigateToPage = vi.fn()
    useTabsStore.setState({ navigateToPage })
    mockedSearchBlocks.mockResolvedValue({
      items: [makePageRow('PAGE_X', 'Xenial')],
      next_cursor: null,
      has_more: false,
      total_count: null,
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
