import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notify } from '@/lib/notify'

// `notify.retry` is the standardised "error + Retry action" helper
// (ui-improvements 2026-05-16 batch). The global Sonner mock from
// `src/test-setup.ts` makes `toast.error` a vi-mock; these tests
// assert the helper routes through it with the dedup-friendly `id`
// default and the action shape every call site can rely on.

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('notify.retry', () => {
  it('forwards to toast.error with the supplied message + default Retry label + auto-dedup id', () => {
    const onRetry = vi.fn()

    notify.retry('Sync failed', onRetry)

    expect(toast.error).toHaveBeenCalledTimes(1)
    const call = vi.mocked(toast.error).mock.calls[0]
    const msg = call?.[0]
    const opts = call?.[1] as Record<string, unknown> | undefined
    expect(msg).toBe('Sync failed')
    expect(opts?.['id']).toBe('retry')
    const action = opts?.['action'] as { label?: string; onClick?: () => void } | undefined
    expect(action?.label).toBe('Retry')

    // The forwarded onClick wraps the supplied callback.
    expect(typeof action?.onClick).toBe('function')
    action?.onClick?.()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('honours an explicit id override (caller scopes dedup more narrowly)', () => {
    notify.retry('Sync failed', vi.fn(), { id: 'sync-error' })
    const opts = vi.mocked(toast.error).mock.calls[0]?.[1] as Record<string, unknown>
    expect(opts['id']).toBe('sync-error')
  })

  it('honours an explicit action.label override (i18n callers wrap with t())', () => {
    notify.retry('Sync failed', vi.fn(), { action: { label: 'Volver a intentar' } })
    const opts = vi.mocked(toast.error).mock.calls[0]?.[1] as Record<string, unknown>
    const action = opts['action'] as { label?: string }
    expect(action.label).toBe('Volver a intentar')
  })

  it('coerces an Error argument by routing through notify.error (uses .message)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = new Error('network unreachable')

    notify.retry(err, vi.fn())

    const call = vi.mocked(toast.error).mock.calls[0]
    expect(call?.[0]).toBe('network unreachable')
    // notifyError logs the original Error so a debugger can stack-trace.
    expect(consoleSpy).toHaveBeenCalledWith(err)
  })
})
