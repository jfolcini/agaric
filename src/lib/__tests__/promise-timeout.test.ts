/**
 * Tests for `runWithTimeout` (#3715 — moved here with the helper itself, from
 * `src/hooks/__tests__/useSyncTrigger.helpers.test.ts`, when the pairing
 * mutation queue became its second caller and the tier-layering guard pushed
 * the shared helper down into `lib`). Unchanged otherwise.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runWithTimeout } from '@/lib/promise-timeout'

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

  it('clears the pending timeout when the underlying promise wins', async () => {
    const racing = runWithTimeout(Promise.resolve('ok'), 1_000, new Error('timeout'))
    await racing
    // After the race resolves, no pending setTimeout should remain — if the
    // timer were still scheduled, vi.getTimerCount() would be ≥ 1.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the pending timeout when the underlying promise rejects', async () => {
    const racing = runWithTimeout(
      Promise.reject(new Error('underlying failure')),
      1_000,
      new Error('timeout'),
    )
    await expect(racing).rejects.toThrow('underlying failure')
    expect(vi.getTimerCount()).toBe(0)
  })
})
