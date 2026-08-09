import { describe, expect, it } from 'vitest'

import { computeNextSyncDelay } from '@/hooks/useSyncTrigger'

// #3715 — `runWithTimeout`'s tests moved with the helper itself to
// `src/lib/__tests__/promise-timeout.test.ts`.

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
