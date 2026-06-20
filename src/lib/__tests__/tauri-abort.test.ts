/**
 * Phase 2.R4 — tests for the AbortSignal IPC wrapper.
 */

import { describe, expect, it } from 'vitest'

import { isCancellation } from '../app-error'
import { cancelledError, withAbort } from '../tauri'

describe('cancelledError', () => {
  it('returns the AppError shape isCancellation recognises', () => {
    const err = cancelledError()
    expect(err).toEqual({ kind: 'cancelled', message: 'aborted client-side' })
    expect(isCancellation(err)).toBe(true)
  })

  it('threads the supplied reason into the message', () => {
    const err = cancelledError('user closed palette')
    expect(err.message).toBe('user closed palette')
    expect(isCancellation(err)).toBe(true)
  })
})

describe('withAbort', () => {
  it('resolves with the promise value when signal never fires', async () => {
    const ctrl = new AbortController()
    await expect(withAbort(Promise.resolve('ok'), ctrl.signal)).resolves.toBe('ok')
  })

  it('forwards rejection from the underlying promise', async () => {
    const ctrl = new AbortController()
    await expect(withAbort(Promise.reject(new Error('boom')), ctrl.signal)).rejects.toThrow('boom')
  })

  it('rejects with a cancelled-kind AppError when signal aborts mid-flight', async () => {
    const ctrl = new AbortController()
    let resolveLater: (v: string) => void = () => {}
    const pending = new Promise<string>((res) => {
      resolveLater = res
    })
    const wrapped = withAbort(pending, ctrl.signal)
    ctrl.abort('palette closed')
    await expect(wrapped).rejects.toMatchObject({ kind: 'cancelled' })
    // Resolving after abort must not throw — wrapper's `onAbort` already
    // settled the outer promise.
    resolveLater('late')
  })

  it('short-circuits when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort('already aborted')
    const wrapped = withAbort(Promise.resolve('never seen'), ctrl.signal)
    await expect(wrapped).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('passes through unchanged when signal is undefined', async () => {
    await expect(withAbort(Promise.resolve('ok'), undefined)).resolves.toBe('ok')
  })

  it('rejected value passes isCancellation predicate', async () => {
    const ctrl = new AbortController()
    const wrapped = withAbort(new Promise(() => {}), ctrl.signal)
    ctrl.abort()
    try {
      await wrapped
      throw new Error('should have rejected')
    } catch (err) {
      expect(isCancellation(err)).toBe(true)
    }
  })
})
