/**
 * PEND-73 Phase 2 — tests for the AppError narrowing helpers.
 *
 * Issue #106 — additional coverage for the discriminated `not_found`,
 * `pool_busy`, `conflict`, `database` kinds and the shared
 * `retryOnPoolBusy` back-pressure helper.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  isAppError,
  isCancellation,
  isConflict,
  isDatabaseError,
  isNotFound,
  isPoolBusy,
  retryOnPoolBusy,
} from '../app-error'

describe('isAppError', () => {
  it('returns true for an IPC-shaped AppError', () => {
    expect(isAppError({ kind: 'cancelled', message: 'x' })).toBe(true)
    expect(isAppError({ kind: 'validation', message: 'bad input' })).toBe(true)
  })

  it('returns false for a non-object', () => {
    expect(isAppError(null)).toBe(false)
    expect(isAppError(undefined)).toBe(false)
    expect(isAppError('not an error')).toBe(false)
    expect(isAppError(42)).toBe(false)
  })

  it('returns false when fields are missing or wrong shape', () => {
    expect(isAppError({})).toBe(false)
    expect(isAppError({ kind: 'validation' })).toBe(false)
    expect(isAppError({ message: 'lonely' })).toBe(false)
    expect(isAppError({ kind: 42, message: 'kind is a number' })).toBe(false)
    expect(isAppError({ kind: 'ok', message: 7 })).toBe(false)
  })

  it("accepts a forward-compat kind the frontend doesn't know yet", () => {
    expect(isAppError({ kind: 'future_variant', message: 'hi' })).toBe(true)
  })
})

describe('isCancellation', () => {
  it('returns true only for kind="cancelled"', () => {
    expect(isCancellation({ kind: 'cancelled', message: 'aborted' })).toBe(true)
  })

  it('returns false for any other kind', () => {
    expect(isCancellation({ kind: 'validation', message: 'x' })).toBe(false)
    expect(isCancellation({ kind: 'not_found', message: 'x' })).toBe(false)
    expect(isCancellation({ kind: 'database', message: 'x' })).toBe(false)
  })

  it('returns false for non-AppError inputs', () => {
    expect(isCancellation(null)).toBe(false)
    expect(isCancellation(new Error('plain JS error'))).toBe(false)
    expect(isCancellation('cancelled')).toBe(false)
  })
})

// Issue #106 — the four new IPC error kinds (`not_found`, `pool_busy`,
// `conflict`, `database`). Each predicate must accept only its own
// kind and reject all the others (no cross-talk in the dispatch
// table), plus reject non-AppError inputs.

describe('isNotFound', () => {
  it('matches only kind="not_found"', () => {
    expect(isNotFound({ kind: 'not_found', message: 'block X' })).toBe(true)
    expect(isNotFound({ kind: 'database', message: 'x' })).toBe(false)
    expect(isNotFound({ kind: 'pool_busy', message: 'x' })).toBe(false)
    expect(isNotFound({ kind: 'conflict', message: 'x' })).toBe(false)
    expect(isNotFound({ kind: 'cancelled', message: 'x' })).toBe(false)
  })

  it('rejects non-AppError inputs', () => {
    expect(isNotFound(null)).toBe(false)
    expect(isNotFound(new Error('not_found'))).toBe(false)
    expect(isNotFound('not_found')).toBe(false)
  })
})

describe('isPoolBusy', () => {
  it('matches only kind="pool_busy"', () => {
    expect(isPoolBusy({ kind: 'pool_busy', message: 'pool exhausted' })).toBe(true)
    expect(isPoolBusy({ kind: 'database', message: 'x' })).toBe(false)
    expect(isPoolBusy({ kind: 'not_found', message: 'x' })).toBe(false)
    expect(isPoolBusy({ kind: 'conflict', message: 'x' })).toBe(false)
  })

  it('rejects non-AppError inputs', () => {
    expect(isPoolBusy(undefined)).toBe(false)
    expect(isPoolBusy({})).toBe(false)
    expect(isPoolBusy('pool_busy')).toBe(false)
  })
})

describe('isConflict', () => {
  it('matches only kind="conflict"', () => {
    expect(isConflict({ kind: 'conflict', message: 'UNIQUE failed' })).toBe(true)
    expect(isConflict({ kind: 'database', message: 'x' })).toBe(false)
    expect(isConflict({ kind: 'not_found', message: 'x' })).toBe(false)
    expect(isConflict({ kind: 'pool_busy', message: 'x' })).toBe(false)
  })

  it('rejects non-AppError inputs', () => {
    expect(isConflict(null)).toBe(false)
    expect(isConflict(new Error('conflict'))).toBe(false)
  })
})

describe('isDatabaseError', () => {
  it('matches only kind="database"', () => {
    expect(isDatabaseError({ kind: 'database', message: 'sqlx blew up' })).toBe(true)
    expect(isDatabaseError({ kind: 'pool_busy', message: 'x' })).toBe(false)
    expect(isDatabaseError({ kind: 'conflict', message: 'x' })).toBe(false)
    expect(isDatabaseError({ kind: 'not_found', message: 'x' })).toBe(false)
  })

  it('rejects non-AppError inputs', () => {
    expect(isDatabaseError(null)).toBe(false)
    expect(isDatabaseError('database')).toBe(false)
  })
})

describe('retryOnPoolBusy', () => {
  const poolBusyErr = { kind: 'pool_busy', message: 'pool busy' }
  const dbErr = { kind: 'database', message: 'syntax error near …' }
  const conflictErr = { kind: 'conflict', message: 'UNIQUE failed' }

  /** Sync sleep stub so tests run without real timers. */
  const noSleep = () => Promise.resolve()

  it('returns the resolved value on the first attempt when the thunk succeeds', async () => {
    const thunk = vi.fn().mockResolvedValue('ok')
    const result = await retryOnPoolBusy(thunk, { sleep: noSleep })
    expect(result).toBe('ok')
    expect(thunk).toHaveBeenCalledTimes(1)
  })

  it('retries on pool_busy and eventually succeeds', async () => {
    const thunk = vi
      .fn()
      .mockRejectedValueOnce(poolBusyErr)
      .mockRejectedValueOnce(poolBusyErr)
      .mockResolvedValueOnce('finally')
    const onRetry = vi.fn()
    const result = await retryOnPoolBusy(thunk, { sleep: noSleep, onRetry })
    expect(result).toBe('finally')
    expect(thunk).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, poolBusyErr)
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, poolBusyErr)
  })

  it('rethrows immediately on a non-pool_busy error (database)', async () => {
    const thunk = vi.fn().mockRejectedValue(dbErr)
    await expect(retryOnPoolBusy(thunk, { sleep: noSleep })).rejects.toEqual(dbErr)
    expect(thunk).toHaveBeenCalledTimes(1)
  })

  it('rethrows immediately on a non-pool_busy error (conflict)', async () => {
    const thunk = vi.fn().mockRejectedValue(conflictErr)
    await expect(retryOnPoolBusy(thunk, { sleep: noSleep })).rejects.toEqual(conflictErr)
    expect(thunk).toHaveBeenCalledTimes(1)
  })

  it('gives up after the configured number of retries and bubbles the last pool_busy', async () => {
    const thunk = vi.fn().mockRejectedValue(poolBusyErr)
    await expect(retryOnPoolBusy(thunk, { sleep: noSleep, delaysMs: [10, 20] })).rejects.toEqual(
      poolBusyErr,
    )
    // 1 initial attempt + 2 retries = 3 calls.
    expect(thunk).toHaveBeenCalledTimes(3)
  })

  it('uses the supplied sleep schedule between retries', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const thunk = vi
      .fn()
      .mockRejectedValueOnce(poolBusyErr)
      .mockRejectedValueOnce(poolBusyErr)
      .mockResolvedValueOnce('ok')
    const delaysMs = [5, 25] as const
    await retryOnPoolBusy(thunk, { sleep, delaysMs })
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenNthCalledWith(1, 5)
    expect(sleep).toHaveBeenNthCalledWith(2, 25)
  })
})
