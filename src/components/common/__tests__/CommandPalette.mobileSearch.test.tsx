/**
 * #899 mobile-search polish — PaletteBody wiring tests.
 *
 * Covers the feature that lives inside the all-pages palette body:
 *  - #131 recent search terms in the empty state (mobile only).
 *
 * It is gated on `useIsMobile()`; the hook is mocked so each test
 * pins the viewport explicitly.
 */

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CommandPalette } from '@/components/common/CommandPalette'
import { useNavigationStore } from '@/stores/navigation'
import { addRecentSearch, getRecentSearches } from '@/stores/recent-searches'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

vi.mock('@/lib/ipc-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc-helpers')>()
  return {
    ...actual,
    searchBlocks: vi.fn(),
    searchBlocksPartitioned: vi.fn(),
  }
})

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => true),
}))

import { useIsMobile } from '@/hooks/useIsMobile'
import { searchBlocks, searchBlocksPartitioned } from '@/lib/ipc-helpers'

const mockedSearchBlocksPartitioned = vi.mocked(searchBlocksPartitioned)
const mockedSearchBlocks = vi.mocked(searchBlocks)
const mockedUseIsMobile = vi.mocked(useIsMobile)

type PartitionedResp = Awaited<ReturnType<typeof searchBlocksPartitioned>>

function emptyPartition(): PartitionedResp['pages'] {
  return { items: [], next_cursor: null, has_more: false, total_count: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseIsMobile.mockReturnValue(true)
  localStorage.clear()
  useCommandPaletteStore.setState({
    open: false,
    mode: 'search',
    query: '',
    pendingViewQuery: null,
    previousFocusedElement: null,
  })
  useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
  useNavigationStore.setState({ currentView: 'pages', selectedBlockId: null })
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

function openPalette(): void {
  act(() => {
    useCommandPaletteStore.getState().open$()
  })
}

describe('#3336 mobile command palette shell', () => {
  it('uses a full-width bottom sheet while preserving the palette flex layout', () => {
    render(<CommandPalette />)
    openPalette()

    const palette = screen.getByTestId('command-palette')
    expect(palette).toHaveClass('bottom-0', 'inset-x-0', 'flex', 'flex-col', 'p-0')
    // The mobile shell must inherit the sheet's height cap rather than the
    // desktop-only `max-h-[80dvh]`, so a tall result list gets a bounded
    // scroll region instead of pushing the input off-screen.
    expect(palette).toHaveClass('max-h-[calc(100dvh-3.5rem-var(--safe-area-top))]')
    // Asserted one class per expectation: `.not.toHaveClass(a, b, c)` only
    // requires that *some* member is absent, so a single grouped negative
    // would still pass with the right-drawer anchor present.
    expect(palette).not.toHaveClass('right-0')
    expect(palette).not.toHaveClass('w-3/4')
    expect(palette).not.toHaveClass('sm:max-w-sm')
    expect(palette).not.toHaveClass('max-h-[80dvh]')
  })

  it('retains the wider, viewport-capped desktop dialog shell', () => {
    mockedUseIsMobile.mockReturnValue(false)
    render(<CommandPalette />)
    openPalette()

    const palette = screen.getByTestId('command-palette')
    expect(palette).toHaveClass(
      'sm:max-w-2xl',
      'max-h-[80dvh]',
      'flex',
      'flex-col',
      'p-0',
      'top-[50%]',
      'left-[50%]',
    )
    expect(palette).not.toHaveClass('bottom-0')
    expect(palette).not.toHaveClass('inset-x-0')
  })
})

describe('#131 recent searches (empty state)', () => {
  it('lists recent search terms when the input is empty on mobile', () => {
    addRecentSearch('alpha')
    addRecentSearch('beta')
    render(<CommandPalette />)
    openPalette()
    expect(screen.getByTestId('palette-recent-searches-group')).toBeInTheDocument()
    expect(screen.getByTestId('palette-recent-search-beta')).toBeInTheDocument()
    expect(screen.getByTestId('palette-recent-search-alpha')).toBeInTheDocument()
  })

  it('does NOT render recent searches on desktop (mobile-gated)', () => {
    mockedUseIsMobile.mockReturnValue(false)
    addRecentSearch('alpha')
    render(<CommandPalette />)
    openPalette()
    expect(screen.queryByTestId('palette-recent-searches-group')).not.toBeInTheDocument()
  })

  it('tapping a recent term refills the query', async () => {
    const user = userEvent.setup()
    addRecentSearch('alpha')
    render(<CommandPalette />)
    openPalette()
    await user.click(screen.getByTestId('palette-recent-search-alpha'))
    expect(useCommandPaletteStore.getState().query).toBe('alpha')
  })

  it('Clear empties the recent-search list', async () => {
    const user = userEvent.setup()
    addRecentSearch('alpha')
    addRecentSearch('beta')
    render(<CommandPalette />)
    openPalette()
    await user.click(screen.getByTestId('palette-recent-searches-clear'))
    expect(getRecentSearches()).toEqual([])
    expect(screen.queryByTestId('palette-recent-searches-group')).not.toBeInTheDocument()
  })

  it('records the query on escalation so it appears next time', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)
    openPalette()
    const input = screen.getByTestId('command-palette-input')
    await user.type(input, 'committed')
    // Mobile escalation CTA is always present in mobile search mode.
    const escalate = await screen.findByTestId('palette-escalation-footer')
    await user.click(escalate)
    expect(getRecentSearches()).toContain('committed')
  })
})
