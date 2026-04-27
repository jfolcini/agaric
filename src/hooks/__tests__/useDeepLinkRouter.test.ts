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

const { mockUnlisten, mockListen, mockNavigateToPage, mockSetView, mockGetCurrentDeepLink } =
  vi.hoisted(() => {
    const mockUnlisten = vi.fn()
    const mockListen = vi.fn().mockResolvedValue(mockUnlisten)
    const mockNavigateToPage = vi.fn()
    const mockSetView = vi.fn()
    const mockGetCurrentDeepLink = vi.fn().mockResolvedValue(null)
    return {
      mockUnlisten,
      mockListen,
      mockNavigateToPage,
      mockSetView,
      mockGetCurrentDeepLink,
    }
  })

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/stores/navigation', () => ({
  useNavigationStore: {
    getState: vi.fn(() => ({
      navigateToPage: mockNavigateToPage,
      setView: mockSetView,
    })),
  },
}))

vi.mock('@/lib/tauri', () => ({
  getCurrentDeepLink: (...args: unknown[]) => mockGetCurrentDeepLink(...args),
}))

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
  localStorage.removeItem(SETTINGS_ACTIVE_TAB_KEY)
})

afterEach(() => {
  if (!hadTauriInternals) {
    // biome-ignore lint/suspicious/noExplicitAny: test cleanup of window property
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
  it('forwards a valid block payload to navigateToPage', () => {
    handleNavigatePayload({ id: 'BLOCK01HJKLMN012345VPQRSTW3' }, 'deeplink:navigate-to-block')
    expect(mockNavigateToPage).toHaveBeenCalledWith('BLOCK01HJKLMN012345VPQRSTW3', '')
  })

  it('rejects payloads missing the id field', () => {
    handleNavigatePayload({}, 'deeplink:navigate-to-block')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('rejects payloads where id is empty', () => {
    handleNavigatePayload({ id: '' }, 'deeplink:navigate-to-page')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('rejects payloads where id is not a string', () => {
    handleNavigatePayload({ id: 42 }, 'deeplink:navigate-to-page')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('rejects null / undefined payloads', () => {
    handleNavigatePayload(null, 'deeplink:navigate-to-block')
    handleNavigatePayload(undefined, 'deeplink:navigate-to-block')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('survives navigateToPage throwing', () => {
    mockNavigateToPage.mockImplementationOnce(() => {
      throw new Error('store boom')
    })
    expect(() =>
      handleNavigatePayload({ id: 'BLOCK01HJKLMN012345VPQRSTW3' }, 'deeplink:navigate-to-block'),
    ).not.toThrow()
  })
})

describe('handleOpenSettingsPayload', () => {
  it('persists tab to localStorage and switches view to settings', () => {
    handleOpenSettingsPayload({ tab: 'keyboard' })
    expect(localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY)).toBe('keyboard')
    expect(mockSetView).toHaveBeenCalledWith('settings')
  })

  it('rejects payloads missing the tab field', () => {
    handleOpenSettingsPayload({})
    expect(mockSetView).not.toHaveBeenCalled()
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
      // biome-ignore lint/suspicious/noExplicitAny: test cleanup of window property
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
      cb({ payload: { id: 'BLOCK01HJKLMN012345VPQRSTW3' } })

      expect(mockNavigateToPage).toHaveBeenCalledWith('BLOCK01HJKLMN012345VPQRSTW3', '')

      unmount()
    })

    it('ignores malformed block payloads', async () => {
      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      const cb = getListenerCallback(DEEPLINK_EVENT_NAVIGATE_TO_BLOCK)
      cb({ payload: { wrongField: 'X' } })

      expect(mockNavigateToPage).not.toHaveBeenCalled()

      unmount()
    })
  })

  describe('navigate-to-page handler', () => {
    it('routes valid page events to navigateToPage', async () => {
      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      const cb = getListenerCallback(DEEPLINK_EVENT_NAVIGATE_TO_PAGE)
      cb({ payload: { id: 'PAGE001HJKLMN012345VPQRSTW' } })

      expect(mockNavigateToPage).toHaveBeenCalledWith('PAGE001HJKLMN012345VPQRSTW', '')

      unmount()
    })
  })

  describe('open-settings handler', () => {
    it('persists tab and switches to settings view', async () => {
      const { unmount } = renderHook(() => useDeepLinkRouter())
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))

      const cb = getListenerCallback(DEEPLINK_EVENT_OPEN_SETTINGS)
      cb({ payload: { tab: 'sync' } })

      expect(localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY)).toBe('sync')
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
  it('routes valid block URLs', () => {
    dispatchLaunchUrl('agaric://block/BLOCK01HJKLMN012345VPQRSTW3')
    expect(mockNavigateToPage).toHaveBeenCalledWith('BLOCK01HJKLMN012345VPQRSTW3', '')
  })

  it('routes valid page URLs', () => {
    dispatchLaunchUrl('agaric://page/PAGE001HJKLMN012345VPQRSTW')
    expect(mockNavigateToPage).toHaveBeenCalledWith('PAGE001HJKLMN012345VPQRSTW', '')
  })

  it('routes valid settings URLs', () => {
    dispatchLaunchUrl('agaric://settings/sync')
    expect(localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY)).toBe('sync')
    expect(mockSetView).toHaveBeenCalledWith('settings')
  })

  it('rejects malformed URL strings', () => {
    dispatchLaunchUrl('not a url')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
    expect(mockSetView).not.toHaveBeenCalled()
  })

  it('rejects wrong-scheme URLs', () => {
    dispatchLaunchUrl('https://example.com/block/X')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('rejects unknown hosts', () => {
    dispatchLaunchUrl('agaric://attack/whatever')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
    expect(mockSetView).not.toHaveBeenCalled()
  })

  it('rejects URLs with no identifier', () => {
    dispatchLaunchUrl('agaric://block/')
    expect(mockNavigateToPage).not.toHaveBeenCalled()
  })

  it('host match is case-insensitive', () => {
    dispatchLaunchUrl('agaric://BLOCK/BLOCK01HJKLMN012345VPQRSTW3')
    expect(mockNavigateToPage).toHaveBeenCalledWith('BLOCK01HJKLMN012345VPQRSTW3', '')
  })

  it('normalises lowercase block ULIDs to uppercase (mirrors Rust router)', () => {
    dispatchLaunchUrl('agaric://block/block01hjklmn012345vpqrstw3')
    expect(mockNavigateToPage).toHaveBeenCalledWith('BLOCK01HJKLMN012345VPQRSTW3', '')
  })

  it('normalises lowercase page ULIDs to uppercase', () => {
    dispatchLaunchUrl('agaric://page/page001hjklmn012345vpqrstw')
    expect(mockNavigateToPage).toHaveBeenCalledWith('PAGE001HJKLMN012345VPQRSTW', '')
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
