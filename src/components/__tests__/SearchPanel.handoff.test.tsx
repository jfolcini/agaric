/**
 * Tests for SearchPanel — E2E-A5 (PEND-58g): the palette→panel
 * `pendingViewQuery` handoff.
 *
 * SearchPanel's mount effect reads
 * `useCommandPaletteStore.getState().pendingViewQuery`:
 *  - non-null AND length > 0 → seed input + debouncedQuery + `searched`,
 *    fire the search, then clear the slot;
 *  - `''` (empty-string escalation seed, PEND-61 CR) → seed nothing but
 *    STILL clear the slot.
 *
 * Unlike the capped test, we do NOT mock `usePaginatedQuery`; the real hook
 * runs against the `invoke` / `../../lib/tauri` stub so we can assert the IPC
 * fired (or didn't).
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import { useNavigationStore } from '../../stores/navigation'
import { useSearchHistoryStore } from '../../stores/search-history'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import { useCommandPaletteStore } from '../../stores/useCommandPaletteStore'
import { SearchPanel } from '../SearchPanel'

// PEND-58f FE-3 — mirror the main SearchPanel.test.tsx virtualizer mock.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (i: number) => number }) => {
    const sizes = Array.from({ length: opts.count }, (_, i) => opts.estimateSize(i))
    let start = 0
    const items = sizes.map((size, index) => {
      const item = { index, key: index, start, size, end: start + size }
      start += size
      return item
    })
    return {
      getVirtualItems: () => items,
      getTotalSize: () => start,
      scrollToIndex: vi.fn(),
      scrollToOffset: vi.fn(),
      measureElement: vi.fn(),
    }
  },
}))

// UX-153: Mock resolvePageByAlias separately so alias-resolution calls don't
// consume values from the FIFO invoke mock queue.
vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    resolvePageByAlias: vi.fn().mockResolvedValue(null),
  }
})

import { resolvePageByAlias } from '../../lib/tauri'

const mockedInvoke = vi.mocked(invoke)

const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(resolvePageByAlias).mockResolvedValue(null)
  useNavigationStore.setState({
    currentView: 'search',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
  useSearchHistoryStore.setState({ bySpace: {}, historyEnabled: true })
  // FEAT-3 Phase 2 — seed the SpaceStore so the render gets past the skeleton.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [
      { id: 'SPACE_TEST', name: 'Test', accent_color: null },
      { id: 'SPACE_OTHER', name: 'Other', accent_color: null },
    ],
    isReady: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
  // Reset the transient handoff slot so tests don't bleed.
  useCommandPaletteStore.setState({ pendingViewQuery: null })
})

describe('SearchPanel — pendingViewQuery handoff (E2E-A5)', () => {
  it('seeds the input and fires the search for a non-empty handoff, then clears the slot', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    // PEND-51 — the palette wrote a handoff query before the panel mounts.
    useCommandPaletteStore.setState({ pendingViewQuery: 'hello' })

    render(<SearchPanel />)

    // (a) the input value is seeded from the handoff slot.
    const input = screen.getByPlaceholderText(t('search.searchPlaceholder')) as HTMLInputElement
    await waitFor(() => {
      expect(input.value).toBe('hello')
    })

    // (b) the search IPC fired with the handoff query.
    await waitFor(() => {
      const searchCall = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'search_blocks')
      expect(searchCall).toBeDefined()
      expect((searchCall?.[1] as { query: string }).query).toBe('hello')
    })

    // (c) the transient slot is consumed exactly once.
    expect(useCommandPaletteStore.getState().pendingViewQuery).toBeNull()
  })

  it('clears the slot but seeds nothing for an empty-string handoff (PEND-61 CR)', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)

    // PEND-61 CR — the "Search everywhere" command writes `''` to land the
    // user on this panel with a clean input. Slot must still be cleared.
    useCommandPaletteStore.setState({ pendingViewQuery: '' })

    render(<SearchPanel />)

    const input = screen.getByPlaceholderText(t('search.searchPlaceholder')) as HTMLInputElement
    expect(input.value).toBe('')

    // The slot is cleared even though nothing was seeded.
    await waitFor(() => {
      expect(useCommandPaletteStore.getState().pendingViewQuery).toBeNull()
    })

    // No search fired (empty seed means an empty query → disabled query).
    expect(mockedInvoke.mock.calls.some(([cmd]) => cmd === 'search_blocks')).toBe(false)
  })

  it('has no a11y violations on the seeded panel', async () => {
    mockedInvoke.mockResolvedValue(emptyPage)
    useCommandPaletteStore.setState({ pendingViewQuery: 'hello' })
    const { container } = render(<SearchPanel />)
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
