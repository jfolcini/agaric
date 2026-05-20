/**
 * PEND-73 Phase 2 — tests for the AppError narrowing helpers.
 */

import { describe, expect, it } from 'vitest'
import { isAppError, isCancellation } from '../app-error'

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
