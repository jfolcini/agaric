import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & {
    error: ReturnType<typeof vi.fn>
    success: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
  }
  fn.error = vi.fn()
  fn.success = vi.fn()
  fn.info = vi.fn()
  return { toast: fn }
})

// Mock tauri.ts
vi.mock('../../lib/tauri', () => ({
  listPeerRefs: vi.fn(),
  startSync: vi.fn(),
  flushAllDrafts: vi.fn(),
}))

vi.mock('../../lib/announcer', () => ({
  announce: vi.fn(),
}))

import { announce } from '../../lib/announcer'
import type { PeerRefRow, SyncSessionInfo } from '../../lib/tauri'
import { flushAllDrafts, listPeerRefs, startSync } from '../../lib/tauri'
import { useSyncStore } from '../../stores/sync'
import { mapPeerRefToInfo, useSyncTrigger } from '../useSyncTrigger'

/**
 * #748 — drive a `visibilitychange` event with the given visibility state.
 * jsdom doesn't flip `document.visibilityState` itself, so we stub the
 * getter before dispatching the event the handler listens for.
 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  })
  Object.defineProperty(document, 'hidden', {
    value: state === 'hidden',
    configurable: true,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Build a `PeerRefRow` with sensible defaults for tests (#1076). */
function makePeerRow(overrides: Partial<PeerRefRow> = {}): PeerRefRow {
  return {
    peer_id: 'PEER1',
    last_hash: null,
    last_sent_hash: null,
    synced_at: null,
    reset_count: 0,
    last_reset_at: null,
    cert_hash: null,
    device_name: null,
    last_address: null,
    ...overrides,
  }
}

const mockListPeerRefs = vi.mocked(listPeerRefs)
const mockStartSync = vi.mocked(startSync)
const mockFlushAllDrafts = vi.mocked(flushAllDrafts)
const mockedAnnounce = vi.mocked(announce)

describe('useSyncTrigger', () => {
  const originalOnLine = navigator.onLine

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockListPeerRefs.mockResolvedValue([])
    mockStartSync.mockResolvedValue({
      state: 'complete',
      local_device_id: 'LOCAL',
      remote_device_id: 'REMOTE',
      ops_received: 0,
      ops_sent: 0,
    })
    mockFlushAllDrafts.mockResolvedValue({ flushed: 0 })
    // Start each test from a known-visible page so visibility transitions
    // are unambiguous (#748).
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    useSyncStore.getState().reset()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(navigator, 'onLine', { value: originalOnLine, configurable: true })
  })

  it('starts not syncing', () => {
    const { result } = renderHook(() => useSyncTrigger())
    expect(result.current.syncing).toBe(false)
  })

  it('triggers sync on mount after delay', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])

    renderHook(() => useSyncTrigger())

    // listPeerRefs should not be called before the 2s delay
    expect(mockListPeerRefs).not.toHaveBeenCalled()

    // Advance past the 2s initial delay and flush async
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })

    expect(mockListPeerRefs).toHaveBeenCalled()
    // `startSync` is now invoked with a progress callback as
    // its second arg so the hook can stream backend state into the
    // sync store. Assert peerId + that a function was passed.
    expect(mockStartSync).toHaveBeenCalledWith('PEER1', expect.any(Function))
  })

  it('syncAll can be called manually', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    // `startSync` is now invoked with a progress callback as
    // its second arg so the hook can stream backend state into the
    // sync store. Assert peerId + that a function was passed.
    expect(mockStartSync).toHaveBeenCalledWith('PEER1', expect.any(Function))
  })

  it('routes Files-variant updates into the sync store', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER_FILES',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])

    // Capture the onProgress callback the hook hands to startSync, then
    // drive it through a realistic Sync→Files→complete sequence and
    // assert the store reflects each tick.
    let capturedOnProgress: Parameters<typeof startSync>[1] | undefined
    mockStartSync.mockImplementation(async (_peerId, onProgress) => {
      capturedOnProgress = onProgress
      return {
        state: 'complete',
        local_device_id: 'L',
        remote_device_id: 'R',
        ops_received: 0,
        ops_sent: 0,
      }
    })

    const { result } = renderHook(() => useSyncTrigger())
    // Kick off sync but don't await yet — we want to drive progress
    // events while it's mid-flight.
    const pending = act(async () => {
      await result.current.syncAll()
    })

    // Wait one microtask so the implementation has captured the callback.
    await act(async () => {
      await Promise.resolve()
    })
    expect(capturedOnProgress).toBeDefined()

    // Tier 2 — receiving phase mid-stream.
    act(() => {
      capturedOnProgress?.({
        kind: 'files',
        phase: 'receiving',
        remote_device_id: 'R',
        files_done: 0,
        files_total: 2,
        bytes_done: 5_000_000,
        bytes_total: 12_000_000,
      })
    })
    {
      const state = useSyncStore.getState()
      expect(state.filePhase).toBe('receiving')
      expect(state.filesTotal).toBe(2)
      expect(state.bytesDone).toBe(5_000_000)
      expect(state.bytesTotal).toBe(12_000_000)
    }

    // Tier 2 — terminal complete tick clears the file affordance.
    act(() => {
      capturedOnProgress?.({
        kind: 'files',
        phase: 'complete',
        remote_device_id: 'R',
        files_done: 2,
        files_total: 2,
        bytes_done: 12_000_000,
        bytes_total: 12_000_000,
      })
    })
    {
      const state = useSyncStore.getState()
      expect(state.filePhase).toBeNull()
      expect(state.filesDone).toBe(0)
      expect(state.bytesDone).toBe(0)
    }

    await pending
  })

  it('silently skips sync when peer list is empty', async () => {
    mockListPeerRefs.mockResolvedValue([])

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(mockStartSync).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
    expect(useSyncStore.getState().state).toBe('idle')
  })

  it('handles sync errors gracefully', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])
    mockStartSync.mockRejectedValue(new Error('connection failed'))

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    // Should not throw — errors are caught
    expect(result.current.syncing).toBe(false)
  })

  it('prevents concurrent sync runs', async () => {
    let resolveSync: (() => void) | undefined
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])
    mockStartSync.mockImplementation(
      () =>
        new Promise<SyncSessionInfo>((resolve) => {
          resolveSync = () =>
            resolve({
              state: 'complete',
              local_device_id: 'L',
              remote_device_id: 'R',
              ops_received: 0,
              ops_sent: 0,
            })
        }),
    )

    const { result } = renderHook(() => useSyncTrigger())

    // Start first sync
    act(() => {
      result.current.syncAll()
    })

    // Wait a tick for the first syncAll to enter the critical section
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // Try second sync while first is in progress — should be a no-op
    await act(async () => {
      await result.current.syncAll()
    })

    // Only one startSync call
    expect(mockStartSync).toHaveBeenCalledTimes(1)

    // Resolve the first
    await act(async () => {
      resolveSync?.()
    })
  })

  it('shows toast.success when all peers sync successfully', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(toast.success).toHaveBeenCalledWith('Sync complete')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows toast.error for per-peer sync failure', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER_FAIL_12345',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])
    mockStartSync.mockRejectedValue(new Error('connection refused'))

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(toast.error).toHaveBeenCalledWith(
      'Sync failed for device PEER_FAIL_12...',
      expect.objectContaining({
        duration: 5000,
        // Per-peer dedup id keyed by the full peer id — different peers
        // surface their own toast, repeated failures from the same peer
        // collapse into one.
        id: 'sync-peer-error:PEER_FAIL_12345',
        action: expect.objectContaining({
          label: 'Retry sync',
          onClick: expect.any(Function),
        }),
      }),
    )
  })

  // Retry action on transient per-peer sync failure
  it('per-peer sync failure toast carries a Retry action that re-runs startSync', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER_RETRY_999',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])
    mockStartSync.mockRejectedValue(new Error('connection refused'))

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    // Initial failure: startSync called once for the peer.
    expect(mockStartSync).toHaveBeenCalledTimes(1)
    // Callable now takes (peerId, onProgress).
    expect(mockStartSync).toHaveBeenCalledWith('PEER_RETRY_999', expect.any(Function))

    // Toast.error received the action with onClick.
    const errorCall = vi.mocked(toast.error).mock.calls[0]
    expect(errorCall).toBeDefined()
    const opts = errorCall?.[1] as { action?: { onClick: () => void } } | undefined
    expect(opts?.action?.onClick).toBeInstanceOf(Function)

    // Click Retry → triggers a fresh sync attempt for the SAME peer.
    await act(async () => {
      opts?.action?.onClick()
      await Promise.resolve()
    })

    expect(mockStartSync).toHaveBeenCalledTimes(2)
    expect(mockStartSync).toHaveBeenLastCalledWith('PEER_RETRY_999', expect.any(Function))
  })

  it('shows toast.error when listPeerRefs fails', async () => {
    mockListPeerRefs.mockRejectedValue(new Error('DB error'))

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(toast.error).toHaveBeenCalledWith(
      'Sync failed',
      expect.objectContaining({ id: 'sync-error' }),
    )
  })

  it('triggers periodic resync every 60 seconds (#446)', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])

    renderHook(() => useSyncTrigger())

    // Advance past initial 2s delay
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    expect(mockStartSync).toHaveBeenCalledTimes(1)

    // Advance to first periodic resync (60s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mockStartSync).toHaveBeenCalledTimes(2)
  })

  it('clears timers on unmount (#446)', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])

    const { unmount } = renderHook(() => useSyncTrigger())

    unmount()

    // Advance past initial delay — should NOT trigger sync
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(mockStartSync).not.toHaveBeenCalled()
  })

  it('sets sync store to error state on listPeerRefs failure (#446)', async () => {
    mockListPeerRefs.mockRejectedValue(new Error('DB error'))

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    const state = useSyncStore.getState()
    expect(state.state).toBe('error')
    expect(state.error).toBe('Sync failed')
  })

  it('doubles resync interval on sync failure (#418)', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])
    mockStartSync.mockRejectedValue(new Error('fail'))

    renderHook(() => useSyncTrigger())

    // Initial sync at 2s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    expect(mockStartSync).toHaveBeenCalledTimes(1)

    // Next sync should be at 120s (doubled from 60s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mockStartSync).toHaveBeenCalledTimes(1) // still 1 — hasn't fired yet

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_100)
    })
    expect(mockStartSync).toHaveBeenCalledTimes(2) // now at ~122s total
  })

  it('resets resync interval on success after failure (#418)', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])
    // First sync fails
    mockStartSync.mockRejectedValueOnce(new Error('fail'))
    // Second sync succeeds
    mockStartSync.mockResolvedValue({
      state: 'complete',
      local_device_id: 'L',
      remote_device_id: 'R',
      ops_received: 0,
      ops_sent: 0,
    })

    renderHook(() => useSyncTrigger())

    // Initial sync at 2s (fails, interval doubles to 120s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    expect(mockStartSync).toHaveBeenCalledTimes(1)

    // Second sync at 120s (succeeds, interval resets to 60s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_100)
    })
    expect(mockStartSync).toHaveBeenCalledTimes(2)

    // Third sync should be at 60s (reset interval)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_100)
    })
    expect(mockStartSync).toHaveBeenCalledTimes(3)
  })

  it('skips sync when navigator is offline (#429)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(mockListPeerRefs).not.toHaveBeenCalled()
    expect(mockStartSync).not.toHaveBeenCalled()
  })

  it('sets offline state when navigator.onLine is false (#667)', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    const state = useSyncStore.getState()
    expect(state.state).toBe('offline')
  })

  it('triggers sync when online event fires (#667)', async () => {
    mockListPeerRefs.mockResolvedValue([
      {
        peer_id: 'PEER1',
        last_hash: null,
        last_sent_hash: null,
        synced_at: null,
        reset_count: 0,
        last_reset_at: null,
        cert_hash: null,
        device_name: null,
        last_address: null,
      },
    ])

    renderHook(() => useSyncTrigger())

    // Fire the online event
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })

    expect(mockListPeerRefs).toHaveBeenCalled()
    // `startSync` is now invoked with a progress callback as
    // its second arg so the hook can stream backend state into the
    // sync store. Assert peerId + that a function was passed.
    expect(mockStartSync).toHaveBeenCalledWith('PEER1', expect.any(Function))
  })

  // Offline → online transition feedback
  it('shows toast.info("Back online. Syncing…") when transitioning offline → online', async () => {
    // Arrange: prior offline state in the sync store.
    useSyncStore.getState().setState('offline')
    expect(useSyncStore.getState().state).toBe('offline')

    mockListPeerRefs.mockResolvedValue([])

    renderHook(() => useSyncTrigger())

    // Act: dispatch the browser online event.
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })

    // Assert: toast.info fired with the expected key value.
    expect(toast.info).toHaveBeenCalledWith('Back online. Syncing\u2026')
  })

  it('does NOT show "back online" toast when state was not offline', async () => {
    // Arrange: idle (not offline) state.
    useSyncStore.getState().setState('idle')

    mockListPeerRefs.mockResolvedValue([])

    renderHook(() => useSyncTrigger())

    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })

    expect(toast.info).not.toHaveBeenCalled()
  })

  // Screen-reader announcements paired with sync toast feedback
  describe('screen reader announcements', () => {
    it('announces sync started and completed on successful sync', async () => {
      mockListPeerRefs.mockResolvedValue([
        {
          peer_id: 'PEER1',
          last_hash: null,
          last_sent_hash: null,
          synced_at: null,
          reset_count: 0,
          last_reset_at: null,
          cert_hash: null,
          device_name: null,
          last_address: null,
        },
      ])

      const { result } = renderHook(() => useSyncTrigger())

      await act(async () => {
        await result.current.syncAll()
      })

      expect(mockedAnnounce).toHaveBeenCalledWith('Sync started')
      expect(mockedAnnounce).toHaveBeenCalledWith('Sync completed')
    })

    it('announces sync failed when listPeerRefs rejects', async () => {
      mockListPeerRefs.mockRejectedValue(new Error('DB error'))

      const { result } = renderHook(() => useSyncTrigger())

      await act(async () => {
        await result.current.syncAll()
      })

      expect(mockedAnnounce).toHaveBeenCalledWith('Sync failed')
    })
  })

  // #1076: the sync store's `peers` slice must reflect the real backend
  // peer list (it was permanently `[]` because nothing ever called
  // `setPeers`). StatusPanel's Sync panel and the sidebar dot gate on it.
  describe('store peers reflect backend (#1076)', () => {
    it('mapPeerRefToInfo maps row → PeerInfo (epoch ms → ISO string)', () => {
      const row = makePeerRow({
        peer_id: 'PEER_MAP',
        synced_at: Date.UTC(2025, 0, 15, 12, 0, 0),
        reset_count: 3,
      })
      expect(mapPeerRefToInfo(row)).toEqual({
        peerId: 'PEER_MAP',
        lastSyncedAt: '2025-01-15T12:00:00.000Z',
        resetCount: 3,
      })
    })

    it('mapPeerRefToInfo keeps lastSyncedAt null when never synced', () => {
      expect(mapPeerRefToInfo(makePeerRow({ synced_at: null })).lastSyncedAt).toBeNull()
    })

    it('populates store peers from listPeerRefs after syncAll', async () => {
      mockListPeerRefs.mockResolvedValue([
        makePeerRow({ peer_id: 'PEER_A', synced_at: Date.UTC(2025, 0, 1), reset_count: 1 }),
        makePeerRow({ peer_id: 'PEER_B', synced_at: null, reset_count: 0 }),
      ])

      const { result } = renderHook(() => useSyncTrigger())
      await act(async () => {
        await result.current.syncAll()
      })

      expect(useSyncStore.getState().peers).toEqual([
        { peerId: 'PEER_A', lastSyncedAt: '2025-01-01T00:00:00.000Z', resetCount: 1 },
        { peerId: 'PEER_B', lastSyncedAt: null, resetCount: 0 },
      ])
    })

    it('clears stale store peers when backend returns none', async () => {
      // Seed a stale peer to prove the empty backend result clears it.
      useSyncStore.getState().setPeers([{ peerId: 'OLD', lastSyncedAt: null, resetCount: 0 }])
      mockListPeerRefs.mockResolvedValue([])

      const { result } = renderHook(() => useSyncTrigger())
      await act(async () => {
        await result.current.syncAll()
      })

      expect(useSyncStore.getState().peers).toEqual([])
    })
  })

  // #748: visibilitychange pause/resume — recover background-suspended
  // sync on resume and persist drafts when backgrounded.
  describe('visibilitychange pause/resume (#748)', () => {
    const peers = [makePeerRow({ peer_id: 'PEER1' })]

    it('on visible: re-arms the timer and triggers syncAll once', async () => {
      mockListPeerRefs.mockResolvedValue(peers)

      renderHook(() => useSyncTrigger())
      // Run the initial mount sync so we're in steady state.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100)
      })
      expect(mockStartSync).toHaveBeenCalledTimes(1)

      // Resume: should fire exactly one immediate syncAll.
      await act(async () => {
        setVisibility('visible')
        await Promise.resolve()
      })
      expect(mockStartSync).toHaveBeenCalledTimes(2)

      // And the timer chain is re-armed: the next periodic tick fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(mockStartSync).toHaveBeenCalledTimes(3)
    })

    it('does NOT double-arm the timer on resume (single chain only)', async () => {
      mockListPeerRefs.mockResolvedValue(peers)

      renderHook(() => useSyncTrigger())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100)
      })
      expect(mockStartSync).toHaveBeenCalledTimes(1)

      // Resume — re-arms once + fires immediate sync (call #2).
      await act(async () => {
        setVisibility('visible')
        await Promise.resolve()
      })
      expect(mockStartSync).toHaveBeenCalledTimes(2)

      // Exactly one 60s tick should fire. If two chains were live we'd
      // see two extra startSync calls here.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(mockStartSync).toHaveBeenCalledTimes(3)
    })

    it('does NOT overlap syncAll when one is already in flight', async () => {
      let resolveSync: (() => void) | undefined
      mockListPeerRefs.mockResolvedValue(peers)
      mockStartSync.mockImplementation(
        () =>
          new Promise<SyncSessionInfo>((resolve) => {
            resolveSync = () =>
              resolve({
                state: 'complete',
                local_device_id: 'L',
                remote_device_id: 'R',
                ops_received: 0,
                ops_sent: 0,
              })
          }),
      )

      const { result } = renderHook(() => useSyncTrigger())

      // Start a sync and let it enter the critical section (in flight).
      act(() => {
        void result.current.syncAll()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(mockStartSync).toHaveBeenCalledTimes(1)

      // Resume while the sync is still in flight — overlap guard must
      // keep it a no-op (no second startSync).
      await act(async () => {
        setVisibility('visible')
        await Promise.resolve()
      })
      expect(mockStartSync).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolveSync?.()
      })
    })

    it('on hidden: flushes all drafts', async () => {
      mockListPeerRefs.mockResolvedValue(peers)

      renderHook(() => useSyncTrigger())

      expect(mockFlushAllDrafts).not.toHaveBeenCalled()

      await act(async () => {
        setVisibility('hidden')
        await Promise.resolve()
      })

      expect(mockFlushAllDrafts).toHaveBeenCalledTimes(1)
    })

    it('removes the visibilitychange listener on unmount', async () => {
      mockListPeerRefs.mockResolvedValue(peers)

      const { unmount } = renderHook(() => useSyncTrigger())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100)
      })
      const callsBefore = mockStartSync.mock.calls.length
      const flushesBefore = mockFlushAllDrafts.mock.calls.length

      unmount()

      // After unmount, neither a visible nor a hidden transition should do
      // anything (listener detached).
      await act(async () => {
        setVisibility('hidden')
        setVisibility('visible')
        await Promise.resolve()
      })

      expect(mockStartSync.mock.calls.length).toBe(callsBefore)
      expect(mockFlushAllDrafts.mock.calls.length).toBe(flushesBefore)
    })

    it('suppresses the spurious timeout toast for a suspended in-flight sync on resume', async () => {
      mockListPeerRefs.mockResolvedValue(peers)
      // Model a background-suspended sync: startSync never resolves while
      // hidden, so the in-flight run's `runWithTimeout` is the race that
      // would (late) reject with "Sync timeout".
      mockStartSync.mockImplementation(() => new Promise<SyncSessionInfo>(() => {}))

      const { result } = renderHook(() => useSyncTrigger())

      // Begin a sync and let it reach the in-flight state.
      act(() => {
        void result.current.syncAll()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(mockStartSync).toHaveBeenCalledTimes(1)

      // Resume: invalidates the suspended run (generation bump). Because
      // the prior run is still genuinely in flight, the overlap guard
      // keeps the resume's syncAll a no-op for now.
      await act(async () => {
        setVisibility('visible')
        await Promise.resolve()
      })

      // The suspended run's timeout fires late (background throttling
      // simulated by advancing past SYNC_TIMEOUT_MS). It must NOT toast —
      // the run was superseded by the resume.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_100)
      })

      expect(toast.error).not.toHaveBeenCalled()
    })
  })
})
