import { invoke } from '@tauri-apps/api/core'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow, makePage } from '@/__tests__/fixtures'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import {
  __resetCalendarPageDatesForTests,
  useCalendarPageDates,
} from '@/hooks/useCalendarPageDates'
import type { SpaceRow } from '@/lib/bindings'
import { formatDate, getCalendarMonthRange } from '@/lib/date-utils'
import { _resetPrefetchPageSubtreeForTest } from '@/lib/prefetch-page-subtree'
import { useBootStore } from '@/stores/boot'
import { useJournalStore } from '@/stores/journal'
import { useNavigationStore } from '@/stores/navigation'
import { createPageBlockStore } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

function calls(cmd: string) {
  return mockedInvoke.mock.calls.filter(([c]) => c === cmd)
}

const todayStr = formatDate(new Date())

describe('useBootStore', () => {
  beforeEach(() => {
    // Reset the store state between tests
    useBootStore.setState({ state: 'booting', error: null })
    useSpaceStore.setState({ availableSpaces: [], lastRefreshOutcome: { kind: 'ok' } })
    __resetCalendarPageDatesForTests()
    _resetPrefetchPageSubtreeForTest()
    // #3225 — `boot()` DOES issue IPC: it awaits the space store's
    // `refreshAvailableSpaces()`, which calls `list_spaces`. Until the
    // strict fallback landed, that call fell through to a mock resolving
    // `undefined`, which `unwrap` reports as success — the store logged
    // "list_spaces returned a non-array response; treating as empty" and
    // the assertions below passed against a shape production never sends.
    mockedInvoke.mockImplementation(mockInvokeCommands({ list_spaces: () => [] }))
  })

  it('starts in booting state', () => {
    const { state } = useBootStore.getState()
    expect(state).toBe('booting')
  })

  it('boot() transitions to ready once the space store has hydrated', async () => {
    // Phase 2 dropped the artificial `invoke('list_blocks')` handshake;
    // #2921 then made `boot()` await the space store's
    // `refreshAvailableSpaces()` (a real `list_spaces` IPC, stubbed above)
    // and flip to 'ready' when it reports a non-hard-error outcome.
    await useBootStore.getState().boot()

    expect(useBootStore.getState().state).toBe('ready')
    expect(useBootStore.getState().error).toBeNull()
  })

  it('error state can be driven externally and retried via boot()', async () => {
    // The `error` state is preserved as an externally-triggerable surface
    // (e.g., a future fatal IPC outage that wants the full-screen recovery
    // prompt). Verify the round-trip: external setState → 'error' →
    // boot() → 'ready'.
    useBootStore.setState({ state: 'error', error: 'externally-driven failure' })
    expect(useBootStore.getState().state).toBe('error')

    await useBootStore.getState().boot()
    expect(useBootStore.getState().state).toBe('ready')
    expect(useBootStore.getState().error).toBeNull()
  })

  // #5438 — the first journal view's fetches run alongside `list_spaces`
  // for the persisted space, instead of one render after each other.
  describe('journal prefetch (#5438)', () => {
    const space = (id: string): SpaceRow => ({ id, name: id, accent_color: null })

    /**
     * What a previous session left in localStorage. The space goes first:
     * the view and journal stores reconcile per space on a space change, and
     * a real switch resets the view to the page editor.
     */
    function persisted(spaceId: string | null): void {
      useSpaceStore.setState({ currentSpaceId: spaceId, isReady: false })
      useNavigationStore.setState({ currentView: 'journal' })
      useJournalStore.setState({ mode: 'daily', currentDate: new Date() })
    }

    it('fetches the page map and today’s subtree while list_spaces is still out; the first load() takes the subtree once', async () => {
      persisted('SPACE_A')
      let resolveSpaces: (spaces: SpaceRow[]) => void = () => {}
      mockedInvoke.mockImplementation(
        mockInvokeCommands({
          list_spaces: () =>
            new Promise<SpaceRow[]>((resolve) => {
              resolveSpaces = resolve
            }),
          list_journal_pages_in_range: () => [makePage({ id: 'P_TODAY', content: todayStr })],
          load_page_subtree: () => ({
            blocks: [makeBlockRow({ id: 'B1', parent_id: 'P_TODAY' })],
            truncated: false,
            total: 1,
          }),
        }),
      )

      const booted = useBootStore.getState().boot()

      // Both journal requests are out before `list_spaces` has answered.
      const { startDate, endDate } = getCalendarMonthRange(new Date())
      expect(mockedInvoke).toHaveBeenCalledWith('list_journal_pages_in_range', {
        startDate,
        endDate,
        scope: { kind: 'active', space_id: 'SPACE_A' },
      })
      await waitFor(() => {
        expect(mockedInvoke).toHaveBeenCalledWith(
          'load_page_subtree',
          expect.objectContaining({ rootBlockId: 'P_TODAY' }),
        )
      })
      expect(useBootStore.getState().state).toBe('booting')

      resolveSpaces([space('SPACE_A')])
      await booted
      expect(useBootStore.getState().state).toBe('ready')

      // The page's first load consumes the parked subtree: no second IPC.
      const store = createPageBlockStore('P_TODAY')
      await store.getState().load()
      expect(store.getState().blocks.map((b) => b.id)).toEqual(['B1'])
      expect(calls('load_page_subtree')).toHaveLength(1)

      // A reload fetches fresh — the prefetch was consumed exactly once.
      await store.getState().load()
      expect(calls('load_page_subtree')).toHaveLength(2)
    })

    it('a stale persisted space costs one caught IPC and the app lands on the real space’s journal', async () => {
      persisted('SPACE_OLD')
      mockedInvoke.mockImplementation(
        mockInvokeCommands({
          list_spaces: () => [space('SPACE_NEW')],
          list_journal_pages_in_range: (args) =>
            (args['scope'] as { space_id: string }).space_id === 'SPACE_OLD'
              ? Promise.reject(new Error('unknown space'))
              : [makePage({ id: 'P_NEW', content: todayStr })],
        }),
      )

      await useBootStore.getState().boot()

      expect(useBootStore.getState().state).toBe('ready')
      expect(useSpaceStore.getState().currentSpaceId).toBe('SPACE_NEW')
      // The stale hint never reached the subtree prefetch.
      expect(calls('list_journal_pages_in_range')).toHaveLength(1)
      expect(calls('load_page_subtree')).toHaveLength(0)

      // The journal view fetches for the real space and owns that round trip.
      const { result } = renderHook(() => useCalendarPageDates(getCalendarMonthRange(new Date())))
      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })
      expect(result.current.pageMap.get(todayStr)).toBe('P_NEW')
      expect(result.current.fetchedThisMount).toBe(true)
      expect(calls('list_journal_pages_in_range')).toHaveLength(2)
    })

    it('prefetches nothing without a persisted space', async () => {
      persisted(null)
      mockedInvoke.mockImplementation(mockInvokeCommands({ list_spaces: () => [space('SPACE_A')] }))

      await useBootStore.getState().boot()

      expect(useBootStore.getState().state).toBe('ready')
      expect(calls('list_journal_pages_in_range')).toHaveLength(0)
    })
  })
})
