/**
 * Tests for src/lib/report-ipc-error.ts — unified IPC error reporting helper.
 */

import type { TFunction } from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
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
import { logger } from '../logger'
import { reportIpcError } from '../report-ipc-error'

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
