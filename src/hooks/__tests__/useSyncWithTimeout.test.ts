/**
 * Tests for useSyncWithTimeout hook.
 *
 * Validates:
 *  - Successful sync (resolves before timeout)
 *  - Timeout (rejects after timeout, calls cancelSync)
 *  - Loading state transitions (true during sync, false after)
 *  - Error handling (non-timeout errors re-thrown without cancelSync)
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/tauri', () => ({
  cancelSync: vi.fn(),
}))

import { cancelSync } from '../../lib/tauri'
import { useSyncWithTimeout } from '../useSyncWithTimeout'

const mockCancelSync = vi.mocked(cancelSync)

describe('useSyncWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockCancelSync.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves when sync completes before timeout', async () => {
    const { result } = renderHook(() => useSyncWithTimeout())
    const syncFn = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      await result.current.execute(syncFn)
    })

    expect(syncFn).toHaveBeenCalledTimes(1)
    expect(mockCancelSync).not.toHaveBeenCalled()
  })

  it('rejects with timeout error after timeout expires', async () => {
    const { result } = renderHook(() => useSyncWithTimeout(1000))
    const syncFn = vi.fn(() => new Promise<void>(() => {})) // never resolves

    let error: Error | undefined
    await act(async () => {
      const promise = result.current.execute(syncFn)
      // Attach catch before advancing time to prevent unhandled rejection
      const caught = promise.catch((err) => {
        error = err as Error
      })
      await vi.advanceTimersByTimeAsync(1000)
      await caught
    })

    expect(error?.message).toBe('Sync timed out')
    expect(mockCancelSync).toHaveBeenCalledTimes(1)
  })

  it('sets loading true during sync and false after', async () => {
    const { result } = renderHook(() => useSyncWithTimeout())
    expect(result.current.loading).toBe(false)

    let resolveFn!: () => void
    const syncFn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFn = resolve
        }),
    )

    let execPromise: Promise<void>
    act(() => {
      execPromise = result.current.execute(syncFn)
    })

    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveFn()
      // biome-ignore lint/style/noNonNullAssertion: assigned in act() above
      await execPromise!
    })

    expect(result.current.loading).toBe(false)
  })

  it('sets loading false after error', async () => {
    const { result } = renderHook(() => useSyncWithTimeout())
    const syncFn = vi.fn().mockRejectedValue(new Error('sync failed'))

    await act(async () => {
      try {
        await result.current.execute(syncFn)
      } catch {
        // expected
      }
    })

    expect(result.current.loading).toBe(false)
  })

  it('re-throws non-timeout errors without calling cancelSync', async () => {
    const { result } = renderHook(() => useSyncWithTimeout())
    const syncFn = vi.fn().mockRejectedValue(new Error('connection refused'))

    let error: Error | undefined
    await act(async () => {
      try {
        await result.current.execute(syncFn)
      } catch (err) {
        error = err as Error
      }
    })

    expect(error?.message).toBe('connection refused')
    expect(mockCancelSync).not.toHaveBeenCalled()
  })

  it('uses custom timeout duration', async () => {
    const { result } = renderHook(() => useSyncWithTimeout(5000))
    const syncFn = vi.fn(() => new Promise<void>(() => {}))

    let error: Error | undefined
    await act(async () => {
      const promise = result.current.execute(syncFn)
      // Attach catch before advancing time to prevent unhandled rejection
      const caught = promise.catch((err) => {
        error = err as Error
      })
      // Not yet timed out at 4999ms
      await vi.advanceTimersByTimeAsync(4999)
      // Now time out
      await vi.advanceTimersByTimeAsync(1)
      await caught
    })

    expect(error?.message).toBe('Sync timed out')
    expect(mockCancelSync).toHaveBeenCalledTimes(1)
  })

  it('clears timeout when sync resolves before timeout', async () => {
    const { result } = renderHook(() => useSyncWithTimeout(5000))
    const syncFn = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      await result.current.execute(syncFn)
    })

    // Advance past the timeout — should NOT cause any unhandled rejection
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(mockCancelSync).not.toHaveBeenCalled()
  })
})
