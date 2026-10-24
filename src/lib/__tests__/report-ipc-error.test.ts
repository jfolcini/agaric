/**
 * Tests for src/lib/report-ipc-error.ts — unified IPC error reporting helper.
 */

import type { TFunction } from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

import { toast } from 'sonner'

import { logger } from '@/lib/logger'
import { reportIpcError, reportIpcErrorWithReason } from '@/lib/report-ipc-error'

const mockT = ((key: string) => `translated:${key}`) as unknown as TFunction

describe('reportIpcError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls logger.error with `(IPC error)` suffix, context and err', () => {
    const err = new Error('boom')
    const ctx = { blockId: 'abc' }
    reportIpcError('TestModule', 'something.failed', err, mockT, ctx)

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      'TestModule',
      'something.failed (IPC error)',
      ctx,
      err,
    )
  })

  it('calls toast.error with t(messageKey)', () => {
    const err = new Error('boom')
    reportIpcError('TestModule', 'something.failed', err, mockT)

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('translated:something.failed')
  })

  it('works without context (passes undefined to logger.error)', () => {
    const err = new Error('no-ctx')
    reportIpcError('TestModule', 'oops', err, mockT)

    expect(logger.error).toHaveBeenCalledWith('TestModule', 'oops (IPC error)', undefined, err)
    expect(toast.error).toHaveBeenCalledWith('translated:oops')
  })

  it('preserves cause chain by passing the original error through to logger.error', () => {
    const root = new Error('root cause')
    const wrapper = new Error('outer', { cause: root })
    reportIpcError('Mod', 'msg', wrapper, mockT, { x: 1 })

    expect(logger.error).toHaveBeenCalledTimes(1)
    const call = vi.mocked(logger.error).mock.calls[0]
    expect(call?.[3]).toBe(wrapper)
    // Verify the original error reference is preserved (cause chain intact)
    expect((call?.[3] as Error)?.cause).toBe(root)
  })

  it('handles non-Error thrown values (string, object)', () => {
    reportIpcError('Mod', 'key', 'string-error', mockT)
    expect(logger.error).toHaveBeenCalledWith('Mod', 'key (IPC error)', undefined, 'string-error')
    expect(toast.error).toHaveBeenCalledWith('translated:key')
  })
})

describe('reportIpcErrorWithReason (#4399)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows a validation AppError's own message instead of the localized key", () => {
    // The shape `unwrap` throws: the deserialized AppError OBJECT, which is
    // NOT an Error instance. This is the half `err instanceof Error ?
    // err.message : undefined` could never reach.
    const err = {
      kind: 'validation',
      message:
        "cannot declare property 'year' as 'number': 1 value(s) already stored under this key " +
        'would be rejected by that type (1 stored as text).',
      code: null,
    }
    reportIpcErrorWithReason('Mod', 'property.errorCreate', err, mockT, { key: 'year' })

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('1 stored as text'))
    // ...and never the generic fallback.
    expect(toast.error).not.toHaveBeenCalledWith('translated:property.errorCreate')
    // The structured log line is still emitted, with the context.
    expect(logger.error).toHaveBeenCalledWith(
      'Mod',
      'property.errorCreate (IPC error)',
      { key: 'year' },
      err,
    )
  })

  it('falls back to the localized key for a transport Error', () => {
    // `typedError` rethrows real `Error`s, so this is a transport failure,
    // not a backend refusal — its text was never written for a user. The
    // `err instanceof Error ? err.message : …` spelling this replaces had it
    // exactly backwards: it showed this one and hid the validation message.
    reportIpcErrorWithReason('Mod', 'property.createDefFailed', new Error('boom'), mockT)
    expect(toast.error).toHaveBeenCalledWith('translated:property.createDefFailed')
    expect(toast.error).not.toHaveBeenCalledWith('boom')
  })

  it('falls back to the localized key for a non-validation AppError', () => {
    // An `internal` message is a correlation id, not something to act on.
    const err = { kind: 'internal', message: 'an internal error occurred (err: 7f3a)' }
    reportIpcErrorWithReason('Mod', 'property.errorCreate', err, mockT)
    expect(toast.error).toHaveBeenCalledWith('translated:property.errorCreate')
  })

  it('falls back to the localized key for a bare string and for an empty message', () => {
    reportIpcErrorWithReason('Mod', 'property.errorCreate', 'string-error', mockT)
    expect(toast.error).toHaveBeenCalledWith('translated:property.errorCreate')

    vi.clearAllMocks()
    reportIpcErrorWithReason(
      'Mod',
      'property.errorCreate',
      { kind: 'validation', message: '   ', code: null },
      mockT,
    )
    expect(toast.error).toHaveBeenCalledWith('translated:property.errorCreate')
  })
})
