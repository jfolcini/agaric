import { act } from '@testing-library/react'
import { createElement } from 'react'
import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mapBackendState, useSyncEvents } from '../useSyncEvents'

// -- Hoisted mocks (vi.mock factories are hoisted above module scope) ---------

const {
  mockUnlisten,
  mockListen,
  toastMock,
  mockSetState,
  mockSetOpsReceived,
  mockSetOpsSent,
  mockUpdateLastSynced,
  mockLoad,
  mockPageBlockRegistry,
  mockPreload,
  mockGetConflicts,
} = vi.hoisted(() => {
  const mockUnlisten = vi.fn()
  const mockListen = vi.fn().mockResolvedValue(mockUnlisten)

  const mock: ReturnType<typeof vi.fn> & {
    error: ReturnType<typeof vi.fn>
    success: ReturnType<typeof vi.fn>
    warning: ReturnType<typeof vi.fn>
  } = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() })

  const mockSetState = vi.fn()
  const mockSetOpsReceived = vi.fn()
  const mockSetOpsSent = vi.fn()
  const mockUpdateLastSynced = vi.fn()
  const mockLoad = vi.fn().mockResolvedValue(undefined)

  const mockPageBlockRegistry = new Map()
  mockPageBlockRegistry.set('PAGE_1', {
    getState: () => ({
      load: mockLoad,
      rootParentId: 'PAGE_1',
    }),
  })

  const mockPreload = vi.fn().mockResolvedValue(undefined)
  const mockGetConflicts = vi
    .fn()
    .mockResolvedValue({ items: [], next_cursor: null, has_more: false })

  return {
    mockUnlisten,
    mockListen,
    toastMock: mock,
    mockSetState,
    mockSetOpsReceived,
    mockSetOpsSent,
    mockUpdateLastSynced,
    mockLoad,
    mockPageBlockRegistry,
    mockPreload,
    mockGetConflicts,
  }
})

// -- vi.mock calls (hoisted to top — only reference vi.hoisted vars) ----------

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('@/stores/sync', () => ({
  useSyncStore: {
    getState: vi.fn(() => ({
      setState: mockSetState,
      setOpsReceived: mockSetOpsReceived,
      setOpsSent: mockSetOpsSent,
      updateLastSynced: mockUpdateLastSynced,
    })),
  },
}))

vi.mock('@/stores/page-blocks', () => ({
  pageBlockRegistry: mockPageBlockRegistry,
}))

vi.mock('@/stores/resolve', () => ({
  useResolveStore: {
    getState: vi.fn(() => ({
      preload: mockPreload,
    })),
  },
}))

vi.mock('@/lib/tauri', () => ({
  getConflicts: (...args: unknown[]) => mockGetConflicts(...args),
}))

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

import { toast } from 'sonner'
import { announce } from '@/lib/announcer'

const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)
const mockedToastWarning = vi.mocked(toast.warning)
const mockedAnnounce = vi.mocked(announce)

// -- Minimal renderHook (matches project pattern) -----------------------------

function renderHook(hookFn: () => void): { unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root

  function TestComponent(): null {
    hookFn()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(TestComponent))
  })

  return {
    unmount() {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

// -- Setup / teardown ---------------------------------------------------------

let hadTauriInternals: boolean

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: React test env global
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()

  // Save original state
  hadTauriInternals = '__TAURI_INTERNALS__' in window

  // Set up __TAURI_INTERNALS__ to enable the hook
  if (!hadTauriInternals) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
  }

  // Reset mock defaults
  mockListen.mockResolvedValue(mockUnlisten)
  mockLoad.mockResolvedValue(undefined)
  mockGetConflicts.mockResolvedValue({ items: [], next_cursor: null, has_more: false })
})

afterEach(() => {
  // Clean up __TAURI_INTERNALS__ if we added it
  if (!hadTauriInternals) {
    // biome-ignore lint/suspicious/noExplicitAny: test cleanup of window property
    delete (window as any).__TAURI_INTERNALS__
  }
})

// -- Helper: extract the listener callback registered for a given event -------

function getListenerCallback<T>(eventName: string): (event: { payload: T }) => void {
  const call = mockListen.mock.calls.find((c) => c[0] === eventName)
  if (!call) throw new Error(`No listener registered for "${eventName}"`)
  return call[1] as (event: { payload: T }) => void
}

// =============================================================================
// Tests
// =============================================================================

describe('mapBackendState', () => {
  it.each([
    ['exchanging_heads', 'syncing'],
    ['streaming_ops', 'syncing'],
    ['applying_ops', 'syncing'],
    ['merging', 'syncing'],
  ])('maps "%s" → "syncing"', (input, expected) => {
    expect(mapBackendState(input)).toBe(expected)
  })

  it('maps "complete" → "idle"', () => {
    expect(mapBackendState('complete')).toBe('idle')
  })

  it.each([
    ['failed', 'error'],
    ['reset_required', 'error'],
  ])('maps "%s" → "error"', (input, expected) => {
    expect(mapBackendState(input)).toBe(expected)
  })

  it('maps "idle" → "idle" (default)', () => {
    expect(mapBackendState('idle')).toBe('idle')
  })

  it('maps unknown string → "idle" (default)', () => {
    expect(mapBackendState('totally_unknown_state')).toBe('idle')
  })
})

describe('useSyncEvents', () => {
  describe('listener registration', () => {
    it('registers listeners for all three sync events', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const eventNames = mockListen.mock.calls.map((c) => c[0])
      expect(eventNames).toContain('sync:progress')
      expect(eventNames).toContain('sync:complete')
      expect(eventNames).toContain('sync:error')

      unmount()
    })

    it('calls unlisten functions on unmount', async () => {
      const unlisten1 = vi.fn()
      const unlisten2 = vi.fn()
      const unlisten3 = vi.fn()
      mockListen
        .mockResolvedValueOnce(unlisten1)
        .mockResolvedValueOnce(unlisten2)
        .mockResolvedValueOnce(unlisten3)

      const { unmount } = renderHook(() => useSyncEvents())

      // Wait for listen promises to resolve
      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      unmount()

      // Each listen() promise either resolves before unmount (cleanup loop calls
      // unlisten) or after (the cancelled-flag branch calls unlisten directly).
      // Either way, all three unlisten functions are eventually invoked — poll
      // for the observable end state instead of relying on a real-timer sleep.
      await vi.waitFor(() => {
        expect(unlisten1).toHaveBeenCalled()
        expect(unlisten2).toHaveBeenCalled()
        expect(unlisten3).toHaveBeenCalled()
      })
    })

    it('no-ops when __TAURI_INTERNALS__ is absent (browser mode)', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test cleanup of window property
      delete (window as any).__TAURI_INTERNALS__

      const { unmount } = renderHook(() => useSyncEvents())

      // useEffect runs synchronously inside act(); the browser-mode early-return
      // schedules no async work. Flush a microtask deterministically as a fence
      // before asserting the negative.
      await Promise.resolve()

      expect(mockListen).not.toHaveBeenCalled()

      unmount()

      // Restore for other tests
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: {},
        writable: true,
        configurable: true,
      })
    })
  })

  describe('sync:progress handler', () => {
    it('updates store state and op counters from progress event', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:progress')
      callback({
        payload: {
          type: 'progress',
          state: 'streaming_ops',
          remote_device_id: 'device-42',
          ops_received: 5,
          ops_sent: 3,
        },
      })

      expect(mockSetState).toHaveBeenCalledWith('syncing')
      expect(mockSetOpsReceived).toHaveBeenCalledWith(5)
      expect(mockSetOpsSent).toHaveBeenCalledWith(3)

      unmount()
    })

    it('maps various backend states correctly via progress events', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:progress')

      callback({
        payload: {
          type: 'progress',
          state: 'applying_ops',
          remote_device_id: 'dev-1',
          ops_received: 0,
          ops_sent: 0,
        },
      })
      expect(mockSetState).toHaveBeenCalledWith('syncing')

      vi.clearAllMocks()

      callback({
        payload: {
          type: 'progress',
          state: 'failed',
          remote_device_id: 'dev-1',
          ops_received: 0,
          ops_sent: 0,
        },
      })
      expect(mockSetState).toHaveBeenCalledWith('error')

      unmount()
    })
  })

  describe('sync:complete handler', () => {
    it('sets idle state, updates counters and lastSynced', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 10,
          ops_sent: 7,
        },
      })

      expect(mockSetState).toHaveBeenCalledWith('idle')
      expect(mockSetOpsReceived).toHaveBeenCalledWith(10)
      expect(mockSetOpsSent).toHaveBeenCalledWith(7)
      expect(mockUpdateLastSynced).toHaveBeenCalledWith(expect.any(String))

      unmount()
    })

    it('shows success toast when ops_received > 0', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 3,
          ops_sent: 0,
        },
      })

      expect(mockedToastSuccess).toHaveBeenCalledWith('Synced 3 changes from device')

      unmount()
    })

    it('shows singular "change" for ops_received === 1', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 1,
          ops_sent: 0,
        },
      })

      expect(mockedToastSuccess).toHaveBeenCalledWith('Synced 1 change from device')

      unmount()
    })

    it('does NOT show toast when ops_received === 0', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 0,
          ops_sent: 5,
        },
      })

      expect(mockedToastSuccess).not.toHaveBeenCalled()

      unmount()
    })

    it('reloads block store when ops_received > 0', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 5,
          ops_sent: 0,
        },
      })

      expect(mockLoad).toHaveBeenCalled()

      unmount()
    })

    it('does NOT reload block store when ops_received === 0', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 0,
          ops_sent: 3,
        },
      })

      expect(mockLoad).not.toHaveBeenCalled()

      unmount()
    })

    it('preloads resolve cache with forceRefresh=true when ops_received > 0 (B-7)', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 5,
          ops_sent: 0,
        },
      })

      expect(mockPreload).toHaveBeenCalledWith(true)

      unmount()
    })

    it('does NOT preload resolve cache when ops_received === 0', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 0,
          ops_sent: 3,
        },
      })

      expect(mockPreload).not.toHaveBeenCalled()

      unmount()
    })

    it('shows conflict warning toast when conflicts exist after sync (#438)', async () => {
      mockGetConflicts.mockResolvedValue({
        items: [
          {
            id: 'CONFLICT1',
            block_type: 'content',
            content: 'conflict',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: true,
          },
        ],
        next_cursor: null,
        has_more: false,
      })

      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-1',
          ops_received: 5,
          ops_sent: 0,
        },
      })

      await vi.waitFor(() => {
        expect(mockedToastWarning).toHaveBeenCalledWith(
          'Sync completed with conflicts — review in Conflicts view',
        )
      })

      unmount()
    })

    it('does NOT show conflict warning when no conflicts exist (#438)', async () => {
      mockGetConflicts.mockResolvedValue({
        items: [],
        next_cursor: null,
        has_more: false,
      })

      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-1',
          ops_received: 5,
          ops_sent: 0,
        },
      })

      // Wait for getConflicts to be invoked (positive observable), then drain
      // the resolved-promise microtask chain so the .then() handler completes
      // before we assert the negative.
      await vi.waitFor(() => expect(mockGetConflicts).toHaveBeenCalled())
      await Promise.resolve()
      await Promise.resolve()

      expect(mockedToastWarning).not.toHaveBeenCalled()

      unmount()
    })

    it('does NOT check conflicts when ops_received === 0 (#438)', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-1',
          ops_received: 0,
          ops_sent: 3,
        },
      })

      // Conflict check is gated behind `if (ops_received > 0)` — the callback
      // body runs synchronously without scheduling any async work in this branch.
      // Flush a microtask as a fence before asserting the negative.
      await Promise.resolve()

      expect(mockGetConflicts).not.toHaveBeenCalled()

      unmount()
    })

    it('silently ignores getConflicts failure (#438)', async () => {
      mockGetConflicts.mockRejectedValue(new Error('IPC error'))

      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-1',
          ops_received: 5,
          ops_sent: 0,
        },
      })

      // Wait for getConflicts to be invoked (positive observable), then drain
      // the rejected-promise microtask chain so the .catch() handler runs
      // before we assert the negative — should not throw.
      await vi.waitFor(() => expect(mockGetConflicts).toHaveBeenCalled())
      await Promise.resolve()
      await Promise.resolve()

      expect(mockedToastWarning).not.toHaveBeenCalled()

      unmount()
    })
  })

  describe('sync:error handler', () => {
    it('sets error state with message', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:error')
      callback({
        payload: {
          type: 'error',
          message: 'Connection timed out',
          remote_device_id: 'device-42',
        },
      })

      expect(mockSetState).toHaveBeenCalledWith('error', 'Connection timed out')

      unmount()
    })

    it('shows error toast with message', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:error')
      callback({
        payload: {
          type: 'error',
          message: 'Connection timed out',
          remote_device_id: 'device-42',
        },
      })

      expect(mockedToastError).toHaveBeenCalledWith('Sync failed: Connection timed out')

      unmount()
    })
  })

  describe('listen rejection (#447)', () => {
    it('handles listen() promise rejection without crashing', async () => {
      mockListen.mockRejectedValue(new Error('IPC unavailable'))

      const { unmount } = renderHook(() => useSyncEvents())

      // Wait for all three listen() calls to be issued (positive observable),
      // then drain the rejected-promise microtask chain so each .catch() handler
      // runs before we assert the negative.
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(3))
      await Promise.resolve()
      await Promise.resolve()

      // Should not crash — hook catches the rejection internally
      // Unlisten should not be called since listen never resolved
      expect(mockUnlisten).not.toHaveBeenCalled()

      unmount()
    })
  })

  // UX-282: screen-reader announcements paired with sync toast feedback
  describe('screen reader announcements (UX-282)', () => {
    it('announces ops received when sync:complete carries ops', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 3,
          ops_sent: 0,
        },
      })

      expect(mockedAnnounce).toHaveBeenCalledWith('3 operations received from sync')

      unmount()
    })

    it('announces conflicts when sync:complete sees conflicts', async () => {
      mockGetConflicts.mockResolvedValue({
        items: [
          {
            id: 'CONFLICT1',
            block_type: 'content',
            content: 'conflict',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: true,
          },
        ],
        next_cursor: null,
        has_more: false,
      })

      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-1',
          ops_received: 2,
          ops_sent: 0,
        },
      })

      await vi.waitFor(() => {
        expect(mockedAnnounce).toHaveBeenCalledWith('Sync completed with conflicts')
      })

      unmount()
    })

    it('announces sync failed on sync:error', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(3)
      })

      const callback = getListenerCallback('sync:error')
      callback({
        payload: {
          type: 'error',
          message: 'Connection timed out',
          remote_device_id: 'device-42',
        },
      })

      expect(mockedAnnounce).toHaveBeenCalledWith('Sync failed')

      unmount()
    })
  })
})
