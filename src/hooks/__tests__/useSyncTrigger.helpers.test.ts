import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeNextSyncDelay, runWithTimeout } from '../useSyncTrigger'

const BASE_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 600_000

describe('computeNextSyncDelay', () => {
  it('resets to BASE_INTERVAL_MS on success', () => {
    expect(computeNextSyncDelay(BASE_INTERVAL_MS, false)).toBe(BASE_INTERVAL_MS)
  })

  it('doubles the current interval on failure', () => {
    expect(computeNextSyncDelay(BASE_INTERVAL_MS, true)).toBe(2 * BASE_INTERVAL_MS)
  })

  it('caps at MAX_INTERVAL_MS when already at the cap', () => {
    expect(computeNextSyncDelay(MAX_INTERVAL_MS, true)).toBe(MAX_INTERVAL_MS)
  })

  it('caps at MAX_INTERVAL_MS when doubling would exceed the cap', () => {
    expect(computeNextSyncDelay(MAX_INTERVAL_MS / 2, true)).toBe(MAX_INTERVAL_MS)
  })

  it('resets to BASE_INTERVAL_MS on success even when current is at the cap', () => {
    expect(computeNextSyncDelay(MAX_INTERVAL_MS, false)).toBe(BASE_INTERVAL_MS)
  })
})

describe('runWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the underlying value when the promise wins the race', async () => {
    const result = runWithTimeout(Promise.resolve('ok'), 1_000, new Error('timeout'))
    await expect(result).resolves.toBe('ok')
  })

  it('rejects with the provided error when the timeout wins the race', async () => {
    const timeoutError = new Error('Sync timeout')
    const pending = new Promise<string>(() => {
      /* never resolves */
    })
    const racing = runWithTimeout(pending, 1_000, timeoutError)
    const assertion = expect(racing).rejects.toBe(timeoutError)
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('propagates rejection from the underlying promise when it loses the race timer', async () => {
    const originalError = new Error('underlying failure')
    const racing = runWithTimeout(Promise.reject(originalError), 1_000, new Error('timeout'))
    await expect(racing).rejects.toBe(originalError)
  })
})
