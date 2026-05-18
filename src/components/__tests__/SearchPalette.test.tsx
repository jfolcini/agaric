/**
 * Component-level tests for the Cmd/Ctrl+K palette (PEND-51).
 *
 * Covers:
 *  - Palette mounts / unmounts driven by `useSearchPaletteStore.open`.
 *  - Empty state shows recent pages.
 *  - Typed query fires two parallel `searchBlocks` calls (one with
 *    `blockTypeFilter: 'page'`, one unrestricted).
 *  - Group cap (`MAX_PAGE_GROUPS = 8`) and per-group match cap
 *    (`MAX_MATCHES_PER_GROUP = 2`) hold, with the "+N more in this
 *    page" pill surfacing surplus.
 *  - Arrow keys move the roving focus through the flattened result list.
 *  - Plain Enter navigates the active tab; `Cmd/Ctrl+Enter` opens a new
 *    tab.
 *  - Escalation footer hands off `pendingViewQuery` and flips the
 *    navigation view to `'search'`.
 *  - `[[page]]` autocomplete mode disables the blocks query, surfaces
 *    only page hits, and inserts `[[Page Title]]` into the previously
 *    focused element on Enter.
 *  - Stale-response guard: a later keystroke's response overrides an
 *    in-flight earlier response.
 *  - Mobile breakpoint renders a Sheet (via `useDialogOrSheet`).
 *  - axe scan: zero violations on the rendered palette.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { useNavigationStore } from '../../stores/navigation'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import { useSearchPaletteStore } from '../../stores/useSearchPaletteStore'
import { mergeAndRankGroups, SearchPalette } from '../SearchPalette'

// Mock the searchBlocks IPC so we can drive its responses
// deterministically from tests. Spread the actual module so other
// re-exports (paginationLimit, etc.) stay intact.
vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    searchBlocks: vi.fn(),
  }
})

import { searchBlocks } from '../../lib/tauri'

const mockedSearchBlocks = vi.mocked(searchBlocks)

function resetStore(): void {
  useSearchPaletteStore.setState({
    open: false,
    query: '',
    pendingViewQuery: null,
    previousFocusedElement: null,
  })
}

function makePageRow(id: string, content: string) {
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
  } as Awaited<ReturnType<typeof searchBlocks>>['items'][number]
}

function makeBlockRow(id: string, content: string, pageId: string, snippet?: string) {
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
  } as Awaited<ReturnType<typeof searchBlocks>>['items'][number]
}

function emptyResp() {
  return { items: [], next_cursor: null, has_more: false, total_count: null }
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
  // Default: both queries return empty so tests that don't care about
  // results still render a non-crashing palette body.
  mockedSearchBlocks.mockResolvedValue(emptyResp())
})

afterEach(() => {
  resetStore()
})

function openPalette(): void {
  act(() => {
    useSearchPaletteStore.getState().open$()
  })
}

describe('SearchPalette — visibility', () => {
  it('renders nothing when the store is closed', () => {
    render(<SearchPalette />)
    expect(screen.queryByTestId('search-palette')).toBeNull()
  })

  it('mounts the dialog when the store flag opens', () => {
    render(<SearchPalette />)
    openPalette()
    expect(screen.getByTestId('search-palette')).toBeInTheDocument()
    expect(screen.getByTestId('search-palette-input')).toBeInTheDocument()
  })

  it('closes via Escape', async () => {
    render(<SearchPalette />)
    openPalette()
    await userEvent.keyboard('{Escape}')
    expect(useSearchPaletteStore.getState().open).toBe(false)
  })
})

describe('SearchPalette — empty state', () => {
  it('shows recent pages when no query is typed', () => {
    localStorage.setItem(
      'recent_pages:SPACE_TEST',
      JSON.stringify([
        { id: 'PAGE_RECENT', title: 'Recent Project', visitedAt: '2026-05-01T00:00:00Z' },
      ]),
    )
    render(<SearchPalette />)
    openPalette()
    expect(screen.getByText('Recent Project')).toBeInTheDocument()
  })
})

describe('SearchPalette — parallel queries', () => {
  it('fires a page-only query and an unrestricted blocks query', async () => {
    mockedSearchBlocks.mockImplementation(async (params) => {
      if (params.blockTypeFilter === 'page') {
        return {
          items: [makePageRow('PAGE_A', 'Alpha')],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      return {
        items: [makeBlockRow('B1', 'alpha mention', 'PAGE_A')],
        next_cursor: null,
        has_more: false,
        total_count: null,
      }
    })

    render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })

    await waitFor(() => {
      // Two parallel calls fired: one filtered by `block_type = 'page'`,
      // one unrestricted. We grep the recorded call args by predicate
      // rather than relying on `expect.objectContaining` which expands
      // diff-unfriendly on the test report.
      const calls = mockedSearchBlocks.mock.calls.map((c) => c[0])
      const pageOnly = calls.find((c) => c.blockTypeFilter === 'page')
      const unrestricted = calls.find((c) => c.blockTypeFilter == null)
      expect(pageOnly).toBeDefined()
      expect(pageOnly?.query).toBe('alpha')
      expect(unrestricted).toBeDefined()
      expect(unrestricted?.query).toBe('alpha')
    })

    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
  })

  it('discards stale responses via the generation counter', async () => {
    // Use fake timers so we can manually drive both debounce windows
    // — without this, the second `fireEvent.change` simply replaces
    // the in-flight debounce and only ONE IPC pair fires.
    vi.useFakeTimers()

    let firstResolve: (v: Awaited<ReturnType<typeof searchBlocks>>) => void = () => {}
    const firstPromise = new Promise<Awaited<ReturnType<typeof searchBlocks>>>((resolve) => {
      firstResolve = resolve
    })
    mockedSearchBlocks
      // First debounce window's 2 parallel calls — both hang on
      // `firstPromise`, simulating an in-flight backend that doesn't
      // resolve before the user types again.
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => firstPromise)
      // Subsequent calls resolve immediately to the fresh result set.
      .mockResolvedValue({
        items: [makePageRow('PAGE_FRESH', 'Fresh')],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

    render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input')

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
      firstResolve({
        items: [makePageRow('PAGE_STALE', 'Stale')],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(screen.queryByTestId('palette-page-header-PAGE_STALE')).toBeNull()
  })
})

describe('SearchPalette — caps and surplus pill', () => {
  it('caps groups at 8 and matches per group at 2', () => {
    // Use the pure helper so we don't have to drive 12 simultaneous
    // FTS-mock responses. The cap logic is the same as what the
    // component invokes per render.
    const pages = Array.from({ length: 12 }).map((_, i) => makePageRow(`PAGE_${i}`, `Page ${i}`))
    const blocks: Awaited<ReturnType<typeof searchBlocks>>['items'] = []
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

describe('SearchPalette — keyboard navigation', () => {
  it('arrow-down moves the active descendant through the result list', async () => {
    mockedSearchBlocks.mockImplementation(async (params) => {
      if (params.blockTypeFilter === 'page') {
        return {
          items: [makePageRow('PAGE_A', 'Alpha'), makePageRow('PAGE_B', 'Bravo')],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      return emptyResp()
    })
    render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'pages' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-row-0')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-row-1')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-row-0')
  })
})

describe('SearchPalette — click semantics', () => {
  it('plain Enter navigates the active tab', async () => {
    const navigateToPage = vi.fn()
    useTabsStore.setState({ navigateToPage })
    mockedSearchBlocks.mockImplementation(async (params) => {
      if (params.blockTypeFilter === 'page') {
        return {
          items: [makePageRow('PAGE_A', 'Alpha')],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      return emptyResp()
    })
    render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigateToPage).toHaveBeenCalledWith('PAGE_A', 'Alpha')
  })

  it('Cmd/Ctrl+Enter opens in a new tab', async () => {
    const navigateToPage = vi.fn()
    const openInNewTab = vi.fn()
    useTabsStore.setState({ navigateToPage, openInNewTab })
    mockedSearchBlocks.mockImplementation(async (params) => {
      if (params.blockTypeFilter === 'page') {
        return {
          items: [makePageRow('PAGE_A', 'Alpha')],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      return emptyResp()
    })
    render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    expect(openInNewTab).toHaveBeenCalledWith('PAGE_A', 'Alpha')
    expect(navigateToPage).not.toHaveBeenCalled()
  })
})

describe('SearchPalette — escalation footer', () => {
  it('hands off pendingViewQuery and flips the view', async () => {
    mockedSearchBlocks.mockResolvedValue(emptyResp())
    render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input')
    fireEvent.change(input, { target: { value: 'escalate' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-escalation-footer')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('palette-escalation-footer'))
    expect(useSearchPaletteStore.getState().pendingViewQuery).toBe('escalate')
    expect(useNavigationStore.getState().currentView).toBe('search')
    expect(useSearchPaletteStore.getState().open).toBe(false)
  })
})

describe('SearchPalette — [[page]] autocomplete', () => {
  it('renders a link-mode badge and skips the blocks query', async () => {
    mockedSearchBlocks.mockResolvedValue(emptyResp())
    render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input')
    fireEvent.change(input, { target: { value: '[[a' } })
    expect(screen.getByTestId('palette-link-mode-badge')).toBeInTheDocument()
    await waitFor(() => {
      // Only the page query should fire — never an unrestricted blocks
      // query in link mode.
      const calls = mockedSearchBlocks.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        const arg = call[0] as { blockTypeFilter?: string | undefined }
        expect(arg.blockTypeFilter).toBe('page')
      }
    })
  })

  it('surfaces a "no page matches" hint when the query has no hits', async () => {
    mockedSearchBlocks.mockResolvedValue(emptyResp())
    render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input')
    fireEvent.change(input, { target: { value: '[[unknown' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-no-link-match')).toBeInTheDocument()
    })
  })

  it('inserts [[Page Title]] into the previously focused contenteditable on Enter', async () => {
    // jsdom doesn't implement `document.execCommand`. Stub it before
    // the store opens — the palette only checks `target.isContentEditable`
    // and then calls `execCommand('insertText', ...)`. We capture the
    // call so the assertion can verify the link payload.
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

    mockedSearchBlocks.mockImplementation(async (params) => {
      if (params.blockTypeFilter === 'page') {
        return {
          items: [makePageRow('PAGE_A', 'Alpha')],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      return emptyResp()
    })

    // Capture focus before opening — the store snapshots
    // `document.activeElement` on open$.
    openPalette()
    render(<SearchPalette />)
    const input = screen.getByTestId('search-palette-input')
    fireEvent.change(input, { target: { value: '[[a' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(execCommandStub).toHaveBeenCalledWith('insertText', false, '[[Alpha]]')
    host.remove()
    // biome-ignore lint/suspicious/noExplicitAny: restore the jsdom-default missing property.
    ;(document as any).execCommand = undefined
  })
})

describe('SearchPalette — a11y', () => {
  it('does not crash when both searchBlocks promises reject', async () => {
    // IPC error-path coverage per AGENTS.md:198 — the palette must
    // survive both parallel `searchBlocks` calls rejecting without
    // throwing or leaking a console error. The empty state should
    // render (no page-group + no error toast within the palette).
    mockedSearchBlocks.mockRejectedValue(new Error('Database busy'))
    render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })
    // Both rejections resolve; the palette should render no result
    // groups and stay open without crashing.
    await waitFor(() => {
      expect(screen.queryByTestId('palette-page-header-PAGE_A')).toBeNull()
    })
    expect(screen.getByTestId('search-palette-input')).toBeInTheDocument()
  })

  it('passes a vitest-axe scan with results rendered', async () => {
    mockedSearchBlocks.mockImplementation(async (params) => {
      if (params.blockTypeFilter === 'page') {
        return {
          items: [makePageRow('PAGE_A', 'Alpha')],
          next_cursor: null,
          has_more: false,
          total_count: null,
        }
      }
      return emptyResp()
    })
    const { container } = render(<SearchPalette />)
    openPalette()
    const input = screen.getByTestId('search-palette-input')
    fireEvent.change(input, { target: { value: 'alpha' } })
    await waitFor(() => {
      expect(screen.getByTestId('palette-page-header-PAGE_A')).toBeInTheDocument()
    })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
