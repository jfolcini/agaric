import { renderHook, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RecoveryStatus } from '@/lib/tauri'

import {
  RECOVERY_DEGRADED_EVENT,
  RECOVERY_DEGRADED_TOAST_ID,
  showRecoveryDegradedBanner,
  useRecoveryStatus,
} from '../useRecoveryStatus'

// -- Hoisted mocks ------------------------------------------------------------

const { mockUnlisten, mockListen, mockGetRecoveryStatus } = vi.hoisted(() => {
  const mockUnlisten = vi.fn()
  const mockListen = vi.fn().mockResolvedValue(mockUnlisten)
  const mockGetRecoveryStatus = vi.fn()
  return { mockUnlisten, mockListen, mockGetRecoveryStatus }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/tauri', () => ({
  getRecoveryStatus: (...args: unknown[]) => mockGetRecoveryStatus(...args),
}))

// `sonner` is mocked globally via test-setup.ts → src/__tests__/mocks/sonner.ts.

const HEALTHY: RecoveryStatus = { degraded: false, replay_errors: [] }
const DEGRADED: RecoveryStatus = {
  degraded: true,
  replay_errors: ['replay aborted: op_log spans 2 devices'],
}

// -- Setup / teardown ---------------------------------------------------------

let hadTauriInternals: boolean

beforeEach(() => {
  vi.clearAllMocks()
  hadTauriInternals = '__TAURI_INTERNALS__' in window
  if (!hadTauriInternals) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
  }
  mockListen.mockResolvedValue(mockUnlisten)
  mockGetRecoveryStatus.mockResolvedValue(HEALTHY)
})

afterEach(() => {
  if (!hadTauriInternals) {
    // oxlint-disable-next-line typescript/no-explicit-any -- test cleanup of window property
    delete (window as any).__TAURI_INTERNALS__
  }
})

function getListenerCallback(eventName: string): (event: { payload: unknown }) => void {
  const call = mockListen.mock.calls.find((c) => c[0] === eventName)
  if (!call) throw new Error(`No listener registered for "${eventName}"`)
  return call[1] as (event: { payload: unknown }) => void
}

// =============================================================================
// Tests
// =============================================================================

describe('event-name constant pinned', () => {
  it('matches the Rust EVENT_RECOVERY_DEGRADED string', () => {
    // src-tauri/src/recovery/mod.rs hard-codes this — keep both in sync.
    expect(RECOVERY_DEGRADED_EVENT).toBe('recovery:degraded')
  })
})

describe('showRecoveryDegradedBanner', () => {
  it('shows a persistent, deduped warning when degraded', () => {
    showRecoveryDegradedBanner(DEGRADED)
    expect(toast.warning).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(toast.warning).mock.calls[0]?.[1]
    expect(opts).toMatchObject({
      id: RECOVERY_DEGRADED_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
    })
  })

  it('stays silent on a healthy boot — no signal, no noise', () => {
    showRecoveryDegradedBanner(HEALTHY)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('useRecoveryStatus — live event', () => {
  it('registers a listener for recovery:degraded when in Tauri', () => {
    renderHook(() => useRecoveryStatus())
    expect(mockListen).toHaveBeenCalledWith(RECOVERY_DEGRADED_EVENT, expect.any(Function))
  })

  it('shows the banner when the backend emits a degraded payload', () => {
    renderHook(() => useRecoveryStatus())
    getListenerCallback(RECOVERY_DEGRADED_EVENT)({ payload: DEGRADED })
    expect(toast.warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: RECOVERY_DEGRADED_TOAST_ID }),
    )
  })

  it('ignores a malformed event payload without throwing', () => {
    renderHook(() => useRecoveryStatus())
    const cb = getListenerCallback(RECOVERY_DEGRADED_EVENT)
    expect(() => cb({ payload: { not: 'a status' } })).not.toThrow()
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('useRecoveryStatus — mount backfill', () => {
  it('queries getRecoveryStatus and shows the banner on a degraded boot', async () => {
    // The live event is emitted by the backend before this listener
    // registers, so the backfill is the path that actually surfaces a
    // degraded boot in practice.
    mockGetRecoveryStatus.mockResolvedValue(DEGRADED)
    renderHook(() => useRecoveryStatus())
    await waitFor(() => expect(mockGetRecoveryStatus).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1))
  })

  it('does not show a banner when the backfill reports a healthy boot', async () => {
    mockGetRecoveryStatus.mockResolvedValue(HEALTHY)
    renderHook(() => useRecoveryStatus())
    await waitFor(() => expect(mockGetRecoveryStatus).toHaveBeenCalledTimes(1))
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('swallows a rejected backfill query', async () => {
    mockGetRecoveryStatus.mockRejectedValue(new Error('ipc down'))
    renderHook(() => useRecoveryStatus())
    await waitFor(() => expect(mockGetRecoveryStatus).toHaveBeenCalledTimes(1))
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('the live event and the backfill collapse into one deduped toast', async () => {
    // Both fire with the same fixed id, so sonner shows a single banner —
    // here we assert both code paths target the same dedup id.
    mockGetRecoveryStatus.mockResolvedValue(DEGRADED)
    renderHook(() => useRecoveryStatus())
    getListenerCallback(RECOVERY_DEGRADED_EVENT)({ payload: DEGRADED })
    await waitFor(() => expect(mockGetRecoveryStatus).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(2))
    for (const [, opts] of vi.mocked(toast.warning).mock.calls) {
      expect(opts).toMatchObject({ id: RECOVERY_DEGRADED_TOAST_ID })
    }
  })
})

describe('useRecoveryStatus — browser mode', () => {
  it('no-ops when __TAURI_INTERNALS__ is absent', async () => {
    // oxlint-disable-next-line typescript/no-explicit-any -- test setup
    delete (window as any).__TAURI_INTERNALS__
    renderHook(() => useRecoveryStatus())
    expect(mockListen).not.toHaveBeenCalled()
    // Give the (skipped) backfill effect a tick to confirm it never runs.
    await Promise.resolve()
    expect(mockGetRecoveryStatus).not.toHaveBeenCalled()
    // Restore for afterEach symmetry.
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
  })
})
