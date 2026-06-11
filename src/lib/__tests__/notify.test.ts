import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { t } from '@/lib/i18n'
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
    // #759: the fallback label routes through the i18n catalog, not a
    // hardcoded English literal.
    expect(action?.label).toBe(t('action.retry'))

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

// Dedup via sonner's `id` field. Sonner natively collapses identical
// `id`s into a single toast — our wrapper's contract is just to forward
// the opts unchanged. These tests pin that contract: an explicit `id`
// reaches `toast.error` / `toast.warning`, and two calls with the same
// id are still both forwarded (the dedup happens inside sonner, not in
// our wrapper, so a per-call mock spy sees both).
describe('notify dedup (id forwarding)', () => {
  it('forwards an explicit id to toast.error for recurring-error categories', () => {
    notify.error('Sync failed', { id: 'sync-error' })

    expect(toast.error).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(toast.error).mock.calls[0]?.[1] as Record<string, unknown> | undefined
    expect(opts?.['id']).toBe('sync-error')
  })

  it('does not synthesise an id when the caller omits one (user-action toasts stack)', () => {
    notify.error('Save failed')

    const call = vi.mocked(toast.error).mock.calls[0]
    // No opts arg forwarded → caller-controlled, dedup opt-in.
    expect(call?.[1]).toBeUndefined()
  })

  it('forwards the same id on repeat calls (sonner does the dedup, not our wrapper)', () => {
    notify.error('Sync failed', { id: 'sync-error' })
    notify.error('Sync failed', { id: 'sync-error' })

    // Both calls reach toast.error — sonner is responsible for
    // collapsing them in the rendered toast list, not us.
    expect(toast.error).toHaveBeenCalledTimes(2)
    const opts1 = vi.mocked(toast.error).mock.calls[0]?.[1] as Record<string, unknown>
    const opts2 = vi.mocked(toast.error).mock.calls[1]?.[1] as Record<string, unknown>
    expect(opts1['id']).toBe('sync-error')
    expect(opts2['id']).toBe('sync-error')
  })

  it('forwards an explicit id to toast.warning (e.g. dependency-warning, repeats per toggle)', () => {
    notify.warning('blocked_by unresolved', { id: 'dependency-warning' })

    expect(toast.warning).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(toast.warning).mock.calls[0]?.[1] as Record<string, unknown> | undefined
    expect(opts?.['id']).toBe('dependency-warning')
  })
})
