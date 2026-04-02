import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

// Mock tauri.ts
vi.mock('../../lib/tauri', () => ({
  listPeerRefs: vi.fn(),
  startSync: vi.fn(),
}))

import type { SyncSessionInfo } from '../../lib/tauri'
import { listPeerRefs, startSync } from '../../lib/tauri'
import { useSyncStore } from '../../stores/sync'
import { useSyncTrigger } from '../useSyncTrigger'

const mockListPeerRefs = vi.mocked(listPeerRefs)
const mockStartSync = vi.mocked(startSync)

describe('useSyncTrigger', () => {
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
    useSyncStore.getState().reset()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
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
    expect(mockStartSync).toHaveBeenCalledWith('PEER1')
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
      },
    ])

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(mockStartSync).toHaveBeenCalledWith('PEER1')
  })

  it('handles empty peer list gracefully', async () => {
    mockListPeerRefs.mockResolvedValue([])

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(mockStartSync).not.toHaveBeenCalled()
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
      },
    ])
    mockStartSync.mockRejectedValue(new Error('connection refused'))

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(toast.error).toHaveBeenCalledWith(
      'Sync failed for device PEER_FAIL_12...',
    )
  })

  it('shows toast.error when listPeerRefs fails', async () => {
    mockListPeerRefs.mockRejectedValue(new Error('DB error'))

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(toast.error).toHaveBeenCalledWith('Sync failed')
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
      },
    ])

    const { result } = renderHook(() => useSyncTrigger())

    await act(async () => {
      await result.current.syncAll()
    })

    expect(mockListPeerRefs).not.toHaveBeenCalled()
    expect(mockStartSync).not.toHaveBeenCalled()

    // Restore
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })
})
