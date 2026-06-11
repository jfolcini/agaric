import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEEPLINK_EVENT_NAVIGATE_TO_BLOCK,
  DEEPLINK_EVENT_NAVIGATE_TO_PAGE,
  DEEPLINK_EVENT_OPEN_SETTINGS,
  dispatchLaunchUrl,
  handleNavigatePayload,
  handleOpenSettingsPayload,
  SETTINGS_ACTIVE_TAB_KEY,
  useDeepLinkRouter,
} from '../useDeepLinkRouter'

// -- Hoisted mocks (vi.mock factories are hoisted above module scope) ---------

const {
  mockUnlisten,
  mockListen,
  mockNavigateToPage,
  mockSetView,
  mockSetPendingSettingsTab,
  mockGetCurrentDeepLink,
  mockGetBlock,
} = vi.hoisted(() => {
  const mockUnlisten = vi.fn()
  const mockListen = vi.fn().mockResolvedValue(mockUnlisten)
  const mockNavigateToPage = vi.fn()
  const mockSetView = vi.fn()
  const mockSetPendingSettingsTab = vi.fn()
  const mockGetCurrentDeepLink = vi.fn().mockResolvedValue(null)
  const mockGetBlock = vi.fn()
  return {
    mockUnlisten,
    mockListen,
    mockNavigateToPage,
    mockSetView,
    mockSetPendingSettingsTab,
    mockGetCurrentDeepLink,
    mockGetBlock,
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/stores/navigation', () => ({
  useNavigationStore: {
    getState: vi.fn(() => ({
      setView: mockSetView,
      setPendingSettingsTab: mockSetPendingSettingsTab,
    })),
  },
}))

// MAINT-127: navigateToPage moved from useNavigationStore to useTabsStore.
// The deep-link hook was updated to call `useTabsStore.getState().navigateToPage(...)`
// — mock that path here so the existing test assertions still observe the spy.
vi.mock('@/stores/tabs', () => ({
  useTabsStore: {
    getState: vi.fn(() => ({
      navigateToPage: mockNavigateToPage,
    })),
  },
}))

vi.mock('@/lib/tauri', () => ({
  getCurrentDeepLink: (...args: unknown[]) => mockGetCurrentDeepLink(...args),
  getBlock: (...args: unknown[]) => mockGetBlock(...args),
}))

// -- Fixtures -------------------------------------------------------------------

const BLOCK_ID = 'BLOCK01HJKLMN012345VPQRSTW3'
const PAGE_ID = 'PAGE001HJKLMN012345VPQRSTW'
const MID_ID = 'MID0001HJKLMN012345VPQRSTW'

/** Minimal BlockRow-shaped fixture for the getBlock mock. `page_id`
 *  defaults to null so the parent-walk FALLBACK tests below stay on the
 *  walk path; the short-circuit tests opt in explicitly. */
function makeBlock(over: {
  id: string
  block_type?: string
  content?: string | null
  parent_id?: string | null
  page_id?: string | null
}) {
  return {
    id: over.id,
    block_type: over.block_type ?? 'page',
    content: over.content ?? '',
    parent_id: over.parent_id ?? null,
    position: null,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: over.page_id ?? null,
  }
}

// -- Setup / teardown ---------------------------------------------------------

let hadTauriInternals: boolean

beforeEach(() => {
  vi.clearAllMocks()

  hadTauriInternals = '__TAURI_INTERNALS__' in window
  if (!hadTauriInternals) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
  }

  mockListen.mockResolvedValue(mockUnlisten)
  mockGetCurrentDeepLink.mockResolvedValue(null)
  // Default: every id resolves to a page block titled '' so legacy
  // `navigateToPage(<id>, '')` expectations hold for the routing tests
  // that don't care about title resolution (#734).
  mockGetBlock.mockImplementation(async (id: string) => makeBlock({ id }))
  localStorage.removeItem(SETTINGS_ACTIVE_TAB_KEY)
})

afterEach(() => {
  if (!hadTauriInternals) {
    // oxlint-disable-next-line typescript/no-explicit-any -- test cleanup of window property
    delete (window as any).__TAURI_INTERNALS__
  }
})

function getListenerCallback(eventName: string): (event: { payload: unknown }) => void {
  const call = mockListen.mock.calls.find((c) => c[0] === eventName)
  if (!call) throw new Error(`No listener registered for "${eventName}"`)
  return call[1] as (event: { payload: unknown }) => void
}

// =============================================================================
// Tests
// =============================================================================

describe('event-name constants pinned', () => {
  // The Rust side asserts the exact same strings — keep both files in sync.
  it('exposes the contract event names', () => {
    expect(DEEPLINK_EVENT_NAVIGATE_TO_BLOCK).toBe('deeplink:navigate-to-block')
    expect(DEEPLINK_EVENT_NAVIGATE_TO_PAGE).toBe('deeplink:navigate-to-page')
    expect(DEEPLINK_EVENT_OPEN_SETTINGS).toBe('deeplink:open-settings')
    expect(SETTINGS_ACTIVE_TAB_KEY).toBe('agaric-settings-active-tab')
  })
})

describe('handleNavigatePayload', () => {
  it('forwards a valid block payload to navigateToPage', async () => {
    await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')
    expect(mockNavigateToPage).toHaveBeenCalledWith(BLOCK_ID, '')
  })

  it('rejects payloads missing the id field', async () => {
    await handleNavigatePayload({}, 'deeplink:navigate-to-block', 'block')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
    expect(mockGetBlock).not.toHaveBeenCalled()
  })

  it('rejects payloads where id is empty', async () => {
    await handleNavigatePayload({ id: '' }, 'deeplink:navigate-to-page', 'page')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('rejects payloads where id is not a string', async () => {
    await handleNavigatePayload({ id: 42 }, 'deeplink:navigate-to-page', 'page')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('rejects null / undefined payloads', async () => {
    await handleNavigatePayload(null, 'deeplink:navigate-to-block', 'block')
    await handleNavigatePayload(undefined, 'deeplink:navigate-to-block', 'block')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('survives navigateToPage throwing', async () => {
    mockNavigateToPage.mockImplementationOnce(() => {
      throw new Error('store boom')
    })
    await expect(
      handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block'),
    ).resolves.toBeUndefined()
  })

  // ── #734 — target resolution ────────────────────────────────────────

  describe('page deep links resolve the real title (#734)', () => {
    it('passes the fetched page title to navigateToPage', async () => {
      mockGetBlock.mockResolvedValueOnce(makeBlock({ id: PAGE_ID, content: 'Project Plan' }))

      await handleNavigatePayload({ id: PAGE_ID }, 'deeplink:navigate-to-page', 'page')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Project Plan')
    })

    it('passes a date-formatted title through so the journal redirect can fire', async () => {
      // tabs.ts keys the UX-242 journal redirect on the TITLE shape — the
      // pre-#734 hardcoded '' meant daily pages always opened in the page
      // editor. The router's job is to deliver the real title.
      mockGetBlock.mockResolvedValueOnce(makeBlock({ id: PAGE_ID, content: '2026-06-11' }))

      await handleNavigatePayload({ id: PAGE_ID }, 'deeplink:navigate-to-page', 'page')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, '2026-06-11')
    })

    it('falls back to navigateToPage(id, "") when getBlock rejects', async () => {
      mockGetBlock.mockRejectedValueOnce(new Error('not found'))

      await handleNavigatePayload({ id: PAGE_ID }, 'deeplink:navigate-to-page', 'page')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, '')
    })

    it('null content degrades to an empty title', async () => {
      mockGetBlock.mockResolvedValueOnce(makeBlock({ id: PAGE_ID, content: null }))

      await handleNavigatePayload({ id: PAGE_ID }, 'deeplink:navigate-to-page', 'page')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, '')
    })
  })

  describe('block deep links resolve the containing page (#734)', () => {
    it('short-circuits through the denormalized page_id — no parent walk', async () => {
      // `blocks.page_id` is materializer-maintained; resolution must be
      // TWO fetches (block + page) regardless of tree depth, never
      // touching the intermediate parent.
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({
            id,
            block_type: 'text',
            content: 'leaf',
            parent_id: MID_ID,
            page_id: PAGE_ID,
          })
        if (id === PAGE_ID) return makeBlock({ id, content: 'Direct Page' })
        throw new Error(`unexpected fetch: ${id}`)
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Direct Page', BLOCK_ID)
      expect(mockGetBlock).toHaveBeenCalledTimes(2)
      expect(mockGetBlock).not.toHaveBeenCalledWith(MID_ID)
    })

    it('a deleted intermediate ancestor cannot break page_id resolution', async () => {
      // The pre-fix parent walk died on the first missing link in the
      // chain; the `page_id` path only needs the block and its page to
      // exist.
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({
            id,
            block_type: 'text',
            content: 'leaf',
            parent_id: MID_ID,
            page_id: PAGE_ID,
          })
        if (id === MID_ID) throw new Error('intermediate ancestor purged')
        return makeBlock({ id: PAGE_ID, content: 'Still Reachable' })
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Still Reachable', BLOCK_ID)
    })

    it('falls back to navigateToPage(id, "") when the page_id fetch rejects', async () => {
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({ id, block_type: 'text', content: 'leaf', page_id: PAGE_ID })
        throw new Error('page purged')
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(BLOCK_ID, '')
    })

    it('a corrupt self-referential page_id on a non-page block falls back to the walk', async () => {
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({
            id,
            block_type: 'text',
            content: 'leaf',
            parent_id: PAGE_ID,
            page_id: BLOCK_ID,
          })
        return makeBlock({ id: PAGE_ID, content: 'Walked Page' })
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Walked Page', BLOCK_ID)
    })

    it('navigates to the parent page with the block id for scroll-and-highlight', async () => {
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({ id, block_type: 'text', content: 'a bullet', parent_id: PAGE_ID })
        return makeBlock({ id: PAGE_ID, content: 'Meeting Notes' })
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Meeting Notes', BLOCK_ID)
    })

    it('walks a nested parent chain up to the page', async () => {
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({ id, block_type: 'text', content: 'leaf', parent_id: MID_ID })
        if (id === MID_ID)
          return makeBlock({ id, block_type: 'text', content: 'mid', parent_id: PAGE_ID })
        return makeBlock({ id: PAGE_ID, content: 'Deep Page' })
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Deep Page', BLOCK_ID)
    })

    it('a block that IS a page navigates directly with its title (no blockId)', async () => {
      mockGetBlock.mockResolvedValueOnce(makeBlock({ id: BLOCK_ID, content: 'Actually a page' }))

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(BLOCK_ID, 'Actually a page')
    })

    it('a date-titled parent page routes with the date title (journal redirect)', async () => {
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({ id, block_type: 'text', content: 'todo', parent_id: PAGE_ID })
        return makeBlock({ id: PAGE_ID, content: '2026-06-11' })
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, '2026-06-11', BLOCK_ID)
    })

    it('an orphaned chain (no page ancestor) lands on the topmost ancestor + blockId', async () => {
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({ id, block_type: 'text', content: 'leaf', parent_id: MID_ID })
        return makeBlock({ id: MID_ID, block_type: 'text', content: 'rootless', parent_id: null })
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(MID_ID, 'rootless', BLOCK_ID)
    })

    it('a parentless non-page block navigates to itself without a blockId', async () => {
      mockGetBlock.mockResolvedValueOnce(
        makeBlock({ id: BLOCK_ID, block_type: 'text', content: 'floating', parent_id: null }),
      )

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(BLOCK_ID, 'floating')
    })

    it('a cyclic parent chain terminates at the hop cap instead of looping forever', async () => {
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({ id, block_type: 'text', content: 'a', parent_id: MID_ID })
        return makeBlock({ id: MID_ID, block_type: 'text', content: 'b', parent_id: BLOCK_ID })
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      // Lands SOMEWHERE deterministic rather than hanging.
      expect(mockNavigateToPage).toHaveBeenCalledTimes(1)
    })

    it('falls back to navigateToPage(id, "") when an ancestor fetch rejects', async () => {
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({ id, block_type: 'text', content: 'leaf', parent_id: PAGE_ID })
        throw new Error('parent purged')
      })

      await handleNavigatePayload({ id: BLOCK_ID }, 'deeplink:navigate-to-block', 'block')

      expect(mockNavigateToPage).toHaveBeenCalledWith(BLOCK_ID, '')
    })
  })
})

describe('handleOpenSettingsPayload', () => {
  it('persists tab to localStorage and switches view to settings', () => {
    handleOpenSettingsPayload({ tab: 'keyboard' })
    expect(localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY)).toBe('keyboard')
    expect(mockSetView).toHaveBeenCalledWith('settings')
  })

  it('writes the pending-tab store slot so an already-open SettingsView updates (#734)', () => {
    handleOpenSettingsPayload({ tab: 'sync' })
    expect(mockSetPendingSettingsTab).toHaveBeenCalledWith('sync')
    expect(mockSetView).toHaveBeenCalledWith('settings')
  })

  it('rejects payloads missing the tab field', () => {
    handleOpenSettingsPayload({})
    expect(mockSetView).not.toHaveBeenCalled()
    expect(mockSetPendingSettingsTab).not.toHaveBeenCalled()
    expect(localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY)).toBeNull()
  })

  it('rejects payloads where tab is empty', () => {
    handleOpenSettingsPayload({ tab: '' })
    expect(mockSetView).not.toHaveBeenCalled()
  })

  it('rejects payloads where tab is not a string', () => {
    handleOpenSettingsPayload({ tab: 0 })
    expect(mockSetView).not.toHaveBeenCalled()
  })

  it('still switches view if localStorage write throws', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('quota exceeded')
    })
    try {
      expect(() => handleOpenSettingsPayload({ tab: 'sync' })).not.toThrow()
      expect(mockSetPendingSettingsTab).toHaveBeenCalledWith('sync')
      expect(mockSetView).toHaveBeenCalledWith('settings')
    } finally {
      Storage.prototype.setItem = original
    }
  })
})

describe('useDeepLinkRouter', () => {
  describe('listener registration', () => {
    it('registers listeners for all three deeplink events', async () => {
      const { unmount } = renderHook(() => useDeepLinkRouter())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const eventNames = mockListen.mock.calls.map((c) => c[0])
      expect(eventNames).toContain(DEEPLINK_EVENT_NAVIGATE_TO_BLOCK)
      expect(eventNames).toContain(DEEPLINK_EVENT_NAVIGATE_TO_PAGE)
      expect(eventNames).toContain(DEEPLINK_EVENT_OPEN_SETTINGS)

      unmount()
    })

    it('calls unlisten functions on unmount', async () => {
      const u1 = vi.fn()
      const u2 = vi.fn()
      const u3 = vi.fn()
      mockListen.mockResolvedValueOnce(u1).mockResolvedValueOnce(u2).mockResolvedValueOnce(u3)

      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      unmount()

      // Each listen() promise either resolves before unmount (cleanup loop
      // calls unlisten) or after (cancelled-flag branch calls unlisten
      // directly).  Either way all three are eventually invoked.
      await vi.waitFor(() => {
        expect(u1).toHaveBeenCalled()
        expect(u2).toHaveBeenCalled()
        expect(u3).toHaveBeenCalled()
      })
    })

    it('no-ops when __TAURI_INTERNALS__ is absent (browser mode)', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any -- test cleanup of window property
      delete (window as any).__TAURI_INTERNALS__

      const { unmount } = renderHook(() => useDeepLinkRouter())
      await Promise.resolve()

      expect(mockListen).not.toHaveBeenCalled()
      expect(mockGetCurrentDeepLink).not.toHaveBeenCalled()

      unmount()

      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: {},
        writable: true,
        configurable: true,
      })
    })

    it('survives a listen() rejection without crashing', async () => {
      mockListen.mockRejectedValue(new Error('IPC unavailable'))

      const { unmount } = renderHook(() => useDeepLinkRouter())

      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))
      await Promise.resolve()
      await Promise.resolve()

      // Should not have invoked any side effects.
      expect(mockNavigateToPage).not.toHaveBeenCalled()
      expect(mockSetView).not.toHaveBeenCalled()

      unmount()
    })
  })

  describe('navigate-to-block handler', () => {
    it('routes valid block events to navigateToPage', async () => {
      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      const cb = getListenerCallback(DEEPLINK_EVENT_NAVIGATE_TO_BLOCK)
      cb({ payload: { id: BLOCK_ID } })

      await vi.waitFor(() => {
        expect(mockNavigateToPage).toHaveBeenCalledWith(BLOCK_ID, '')
      })

      unmount()
    })

    it('resolves a content block to its containing page (#734)', async () => {
      mockGetBlock.mockImplementation(async (id: string) => {
        if (id === BLOCK_ID)
          return makeBlock({ id, block_type: 'text', content: 'bullet', parent_id: PAGE_ID })
        return makeBlock({ id: PAGE_ID, content: 'Host Page' })
      })

      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      const cb = getListenerCallback(DEEPLINK_EVENT_NAVIGATE_TO_BLOCK)
      cb({ payload: { id: BLOCK_ID } })

      await vi.waitFor(() => {
        expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Host Page', BLOCK_ID)
      })

      unmount()
    })

    it('ignores malformed block payloads', async () => {
      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      const cb = getListenerCallback(DEEPLINK_EVENT_NAVIGATE_TO_BLOCK)
      cb({ payload: { wrongField: 'X' } })
      await Promise.resolve()

      expect(mockNavigateToPage).not.toHaveBeenCalled()

      unmount()
    })
  })

  describe('navigate-to-page handler', () => {
    it('routes valid page events to navigateToPage with the fetched title', async () => {
      mockGetBlock.mockResolvedValueOnce(makeBlock({ id: PAGE_ID, content: 'Roadmap' }))

      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      const cb = getListenerCallback(DEEPLINK_EVENT_NAVIGATE_TO_PAGE)
      cb({ payload: { id: PAGE_ID } })

      await vi.waitFor(() => {
        expect(mockNavigateToPage).toHaveBeenCalledWith(PAGE_ID, 'Roadmap')
      })

      unmount()
    })
  })

  describe('open-settings handler', () => {
    it('persists tab, writes the store slot, and switches to settings view', async () => {
      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      const cb = getListenerCallback(DEEPLINK_EVENT_OPEN_SETTINGS)
      cb({ payload: { tab: 'sync' } })

      expect(localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY)).toBe('sync')
      expect(mockSetPendingSettingsTab).toHaveBeenCalledWith('sync')
      expect(mockSetView).toHaveBeenCalledWith('settings')

      unmount()
    })

    it('ignores malformed settings payloads', async () => {
      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      const cb = getListenerCallback(DEEPLINK_EVENT_OPEN_SETTINGS)
      cb({ payload: { tab: '' } })

      expect(mockSetView).not.toHaveBeenCalled()

      unmount()
    })
  })

  describe('launch-URL backfill', () => {
    it('calls getCurrentDeepLink on mount', async () => {
      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockGetCurrentDeepLink).toHaveBeenCalled())
      unmount()
    })

    it('routes a block launch URL through navigateToPage', async () => {
      mockGetCurrentDeepLink.mockResolvedValueOnce(['agaric://block/BLOCK01HJKLMN012345VPQRSTW3'])

      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => {
        expect(mockNavigateToPage).toHaveBeenCalledWith('BLOCK01HJKLMN012345VPQRSTW3', '')
      })
      unmount()
    })

    it('routes a settings launch URL through setView', async () => {
      mockGetCurrentDeepLink.mockResolvedValueOnce(['agaric://settings/keyboard'])

      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => {
        expect(mockSetView).toHaveBeenCalledWith('settings')
      })
      expect(localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY)).toBe('keyboard')
      expect(mockSetPendingSettingsTab).toHaveBeenCalledWith('keyboard')
      unmount()
    })

    it('does not dispatch when getCurrent returns null', async () => {
      mockGetCurrentDeepLink.mockResolvedValueOnce(null)

      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockGetCurrentDeepLink).toHaveBeenCalled())
      // Listeners are registered, but no payload-dispatched yet.
      expect(mockNavigateToPage).not.toHaveBeenCalled()
      expect(mockSetView).not.toHaveBeenCalled()
      unmount()
    })

    it('does not dispatch when getCurrent returns an empty array', async () => {
      mockGetCurrentDeepLink.mockResolvedValueOnce([])

      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockGetCurrentDeepLink).toHaveBeenCalled())
      expect(mockNavigateToPage).not.toHaveBeenCalled()
      unmount()
    })

    it('survives a getCurrent rejection', async () => {
      mockGetCurrentDeepLink.mockRejectedValueOnce(new Error('plugin missing'))

      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockGetCurrentDeepLink).toHaveBeenCalled())
      // No crash; listeners still registered.
      expect(mockListen).toHaveBeenCalledTimes(3)
      unmount()
    })
  })
})

describe('dispatchLaunchUrl', () => {
  it('routes valid block URLs', async () => {
    dispatchLaunchUrl('agaric://block/BLOCK01HJKLMN012345VPQRSTW3')
    await vi.waitFor(() => {
      expect(mockNavigateToPage).toHaveBeenCalledWith('BLOCK01HJKLMN012345VPQRSTW3', '')
    })
  })

  it('routes valid page URLs', async () => {
    dispatchLaunchUrl('agaric://page/PAGE001HJKLMN012345VPQRSTW')
    await vi.waitFor(() => {
      expect(mockNavigateToPage).toHaveBeenCalledWith('PAGE001HJKLMN012345VPQRSTW', '')
    })
  })

  it('routes valid settings URLs', () => {
    dispatchLaunchUrl('agaric://settings/sync')
    expect(localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY)).toBe('sync')
    expect(mockSetPendingSettingsTab).toHaveBeenCalledWith('sync')
    expect(mockSetView).toHaveBeenCalledWith('settings')
  })

  it('rejects malformed URL strings', async () => {
    dispatchLaunchUrl('not a url')
    await Promise.resolve()
    expect(mockNavigateToPage).not.toHaveBeenCalled()
    expect(mockSetView).not.toHaveBeenCalled()
  })

  it('rejects wrong-scheme URLs', async () => {
    dispatchLaunchUrl('https://example.com/block/X')
    await Promise.resolve()
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('rejects unknown hosts', async () => {
    dispatchLaunchUrl('agaric://attack/whatever')
    await Promise.resolve()
    expect(mockNavigateToPage).not.toHaveBeenCalled()
    expect(mockSetView).not.toHaveBeenCalled()
  })

  it('rejects URLs with no identifier', async () => {
    dispatchLaunchUrl('agaric://block/')
    await Promise.resolve()
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('host match is case-insensitive', async () => {
    dispatchLaunchUrl('agaric://BLOCK/BLOCK01HJKLMN012345VPQRSTW3')
    await vi.waitFor(() => {
      expect(mockNavigateToPage).toHaveBeenCalledWith('BLOCK01HJKLMN012345VPQRSTW3', '')
    })
  })

  it('normalises lowercase block ULIDs to uppercase (mirrors Rust router)', async () => {
    dispatchLaunchUrl('agaric://block/block01hjklmn012345vpqrstw3')
    await vi.waitFor(() => {
      expect(mockNavigateToPage).toHaveBeenCalledWith('BLOCK01HJKLMN012345VPQRSTW3', '')
    })
  })

  it('normalises lowercase page ULIDs to uppercase', async () => {
    dispatchLaunchUrl('agaric://page/page001hjklmn012345vpqrstw')
    await vi.waitFor(() => {
      expect(mockNavigateToPage).toHaveBeenCalledWith('PAGE001HJKLMN012345VPQRSTW', '')
    })
  })

  it('does NOT uppercase the settings tab identifier', () => {
    dispatchLaunchUrl('agaric://settings/Keyboard')
    // Settings tab names are not ULIDs and are case-sensitive in the
    // router (lowercase `keyboard` is the canonical form on disk; a
    // mixed-case input should pass through unchanged for downstream
    // matching to handle).
    expect(localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY)).toBe('Keyboard')
  })
})
