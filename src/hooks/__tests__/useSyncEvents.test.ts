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
  mockLoad2,
  mockPageBlockRegistry,
  mockPreload,
  mockReanchorUndo,
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
  // #1071 — a SECOND mounted page store so targeted-vs-fallback tests can
  // assert that only the changed page reloads (PAGE_1) while the untouched
  // one (PAGE_2) is skipped, and that the fallback reloads BOTH.
  const mockLoad2 = vi.fn().mockResolvedValue(undefined)

  const mockPageBlockRegistry = new Map()
  mockPageBlockRegistry.set('PAGE_1', {
    getState: () => ({
      load: mockLoad,
      rootParentId: 'PAGE_1',
    }),
  })
  mockPageBlockRegistry.set('PAGE_2', {
    getState: () => ({
      load: mockLoad2,
      rootParentId: 'PAGE_2',
    }),
  })

  const mockPreload = vi.fn().mockResolvedValue(undefined)
  const mockReanchorUndo = vi.fn()

  return {
    mockUnlisten,
    mockListen,
    toastMock: mock,
    mockSetState,
    mockSetOpsReceived,
    mockSetOpsSent,
    mockUpdateLastSynced,
    mockLoad,
    mockLoad2,
    mockPageBlockRegistry,
    mockPreload,
    mockReanchorUndo,
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

// #731 — useSyncEvents re-anchors each reloaded page's undo state.
vi.mock('@/stores/undo', () => ({
  useUndoStore: {
    getState: vi.fn(() => ({
      reanchorAfterRemoteOps: mockReanchorUndo,
    })),
  },
}))

vi.mock('@/stores/resolve', () => ({
  useResolveStore: {
    getState: vi.fn(() => ({
      preload: mockPreload,
    })),
  },
}))

// FEAT-3p7 — `useSyncEvents.preload(spaceId, true)` reads
// `useSpaceStore.currentSpaceId`. Mock with a deterministic
// active-space id so the test asserts the spaceId arg is forwarded.
vi.mock('@/stores/space', () => ({
  useSpaceStore: {
    getState: vi.fn(() => ({ currentSpaceId: 'SPACE_TEST' })),
  },
}))

vi.mock('@/lib/announcer', () => ({
  announce: vi.fn(),
}))

import { toast } from 'sonner'

import { announce } from '@/lib/announcer'

const mockedToastSuccess = vi.mocked(toast.success)
const mockedToastError = vi.mocked(toast.error)
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
  // oxlint-disable-next-line typescript/no-explicit-any -- React test env global
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
})

afterEach(() => {
  // Clean up __TAURI_INTERNALS__ if we added it
  if (!hadTauriInternals) {
    // oxlint-disable-next-line typescript/no-explicit-any -- test cleanup of window property
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
    it('registers listeners for sync:complete and sync:error (PEND-06 Phase 2)', async () => {
      // PEND-06 Phase 2 dropped the `sync:progress` listener — the
      // Channel<SyncProgressUpdate> opened by `startSync` is the
      // canonical source for progress now (see `useSyncTrigger`).
      // Keeping the assertion as 2 (down from 3 in Phase 1) pins the
      // contract; if a future change re-introduces the legacy listener
      // it is a deliberate decision, not a silent regression.
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
      })

      const eventNames = mockListen.mock.calls.map((c) => c[0])
      expect(eventNames).toContain('sync:complete')
      expect(eventNames).toContain('sync:error')
      expect(eventNames).not.toContain('sync:progress')

      unmount()
    })

    it('calls unlisten functions on unmount', async () => {
      const unlisten1 = vi.fn()
      const unlisten2 = vi.fn()
      mockListen.mockResolvedValueOnce(unlisten1).mockResolvedValueOnce(unlisten2)

      const { unmount } = renderHook(() => useSyncEvents())

      // Wait for listen promises to resolve
      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
      })

      unmount()

      // Each listen() promise either resolves before unmount (cleanup loop calls
      // unlisten) or after (the cancelled-flag branch calls unlisten directly).
      // Either way, both unlisten functions are eventually invoked — poll
      // for the observable end state instead of relying on a real-timer sleep.
      await vi.waitFor(() => {
        expect(unlisten1).toHaveBeenCalled()
        expect(unlisten2).toHaveBeenCalled()
      })
    })

    it('no-ops when __TAURI_INTERNALS__ is absent (browser mode)', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any -- test cleanup of window property
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

  // PEND-06 Phase 2 — `sync:progress` listener was dropped. Per-state
  // progress (`streaming_ops`, `applying_ops`, etc.) now flows through
  // the Channel<SyncProgressUpdate> set up by `startSync`; see the
  // useSyncTrigger tests for the consumer side. The `mapBackendState`
  // helper that used to back this handler is still exported (used by
  // `useSyncTrigger`'s channel callback) and tested separately above.

  describe('sync:complete handler', () => {
    it('sets idle state, updates counters and lastSynced', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
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
        expect(mockListen).toHaveBeenCalledTimes(2)
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
        expect(mockListen).toHaveBeenCalledTimes(2)
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
        expect(mockListen).toHaveBeenCalledTimes(2)
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
        expect(mockListen).toHaveBeenCalledTimes(2)
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

    it('re-anchors undo state for each reloaded page when ops_received > 0 (#731)', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
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

      // Remote ops shifted the backend op-log indexing that undoDepth
      // addresses; the page's positional undo anchor must be reset, keyed by
      // the same pageId the block reload uses (#731).
      expect(mockReanchorUndo).toHaveBeenCalledWith('PAGE_1')

      unmount()
    })

    it('does NOT re-anchor undo state when ops_received === 0 (#731)', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
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

      expect(mockReanchorUndo).not.toHaveBeenCalled()

      unmount()
    })

    it('does NOT reload block store when ops_received === 0', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
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
        expect(mockListen).toHaveBeenCalledTimes(2)
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

      // FEAT-3p7 — preload now takes (spaceId, forceRefresh). The
      // sync-events hook reads currentSpaceId from useSpaceStore (mocked
      // to 'SPACE_TEST' above) and forwards forceRefresh=true.
      expect(mockPreload).toHaveBeenCalledWith('SPACE_TEST', true)

      unmount()
    })

    it('does NOT preload resolve cache when ops_received === 0', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
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
  })

  // #1071 — targeted post-sync invalidation. When the backend threads the
  // set of page-root ids its applied ops touched (`changed_page_ids`), the
  // handler reloads ONLY those mounted page stores; when the field is
  // absent/empty it falls back to reloading EVERY mounted store.
  describe('targeted invalidation (#1071)', () => {
    it('reloads ONLY the changed page store when changed_page_ids is present', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 5,
          ops_sent: 0,
          changed_page_ids: ['PAGE_1'],
        },
      })

      // PAGE_1 was touched → reloaded + re-anchored; PAGE_2 was NOT in the
      // set → skipped entirely (the whole point of #1071: no O(mounted) fan-out).
      expect(mockLoad).toHaveBeenCalledTimes(1)
      expect(mockLoad2).not.toHaveBeenCalled()
      expect(mockReanchorUndo).toHaveBeenCalledWith('PAGE_1')
      expect(mockReanchorUndo).not.toHaveBeenCalledWith('PAGE_2')

      unmount()
    })

    it('reloads ALL mounted stores when changed_page_ids is absent (fallback)', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
      })

      const callback = getListenerCallback('sync:complete')
      // No changed_page_ids field — an older backend / unknown protocol.
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 5,
          ops_sent: 0,
        },
      })

      // Fallback: every mounted store reloads + re-anchors (pre-#1071 behaviour).
      expect(mockLoad).toHaveBeenCalledTimes(1)
      expect(mockLoad2).toHaveBeenCalledTimes(1)
      expect(mockReanchorUndo).toHaveBeenCalledWith('PAGE_1')
      expect(mockReanchorUndo).toHaveBeenCalledWith('PAGE_2')

      unmount()
    })

    it('reloads ALL mounted stores when changed_page_ids is empty (fallback)', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
      })

      const callback = getListenerCallback('sync:complete')
      // Empty set (e.g. snapshot catch-up reimports a whole space, or no
      // page resolved) → fall back to reloading everything.
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 5,
          ops_sent: 0,
          changed_page_ids: [],
        },
      })

      expect(mockLoad).toHaveBeenCalledTimes(1)
      expect(mockLoad2).toHaveBeenCalledTimes(1)

      unmount()
    })

    it('skips unmounted page ids in the changed set (no crash)', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
      })

      const callback = getListenerCallback('sync:complete')
      // A page changed remotely but isn't mounted locally → nothing to
      // reload; the mounted-but-untouched stores stay untouched too.
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 2,
          ops_sent: 0,
          changed_page_ids: ['PAGE_NOT_MOUNTED'],
        },
      })

      expect(mockLoad).not.toHaveBeenCalled()
      expect(mockLoad2).not.toHaveBeenCalled()

      unmount()
    })

    it('still preloads the resolve cache in targeted mode (a page/tag title may have changed)', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
      })

      const callback = getListenerCallback('sync:complete')
      callback({
        payload: {
          type: 'complete',
          remote_device_id: 'device-42',
          ops_received: 5,
          ops_sent: 0,
          changed_page_ids: ['PAGE_1'],
        },
      })

      expect(mockPreload).toHaveBeenCalledWith('SPACE_TEST', true)

      unmount()
    })
  })

  describe('sync:error handler', () => {
    it('sets error state with message', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
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
        expect(mockListen).toHaveBeenCalledTimes(2)
      })

      const callback = getListenerCallback('sync:error')
      callback({
        payload: {
          type: 'error',
          message: 'Connection timed out',
          remote_device_id: 'device-42',
        },
      })

      expect(mockedToastError).toHaveBeenCalledWith(
        'Sync failed: Connection timed out',
        // sync:error fires per failing sync attempt — dedup so a flaky
        // network doesn't stack a toast per retry.
        expect.objectContaining({ id: 'sync-error' }),
      )

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
      await vi.waitFor(() => expect(mockListen).toHaveBeenCalledTimes(2))
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
        expect(mockListen).toHaveBeenCalledTimes(2)
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

    it('announces sync failed on sync:error', async () => {
      const { unmount } = renderHook(() => useSyncEvents())

      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2)
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
