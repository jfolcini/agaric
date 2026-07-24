/**
 * Tests for useMdnsStatus (#2506).
 *
 * Mirrors useRecoveryStatus.test.ts's shape: a live-event path and a
 * mount-time backfill path that covers the daemon-starts-before-webview-
 * mounts race.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SYNC_MDNS_DISABLED_EVENT, useMdnsStatus } from '@/hooks/useMdnsStatus'
import type { MdnsStatus } from '@/lib/bindings'

// -- Hoisted mocks ------------------------------------------------------------

const { mockUnlisten, mockListen, mockGetMdnsStatus } = vi.hoisted(() => {
  const unlisten = vi.fn()
  const listen = vi.fn().mockResolvedValue(unlisten)
  const getMdnsStatus = vi.fn()
  return { mockUnlisten: unlisten, mockListen: listen, mockGetMdnsStatus: getMdnsStatus }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/bindings', () => ({
  commands: {
    getMdnsStatus: (...args: unknown[]) => mockGetMdnsStatus(...args),
  },
}))

/** Wrap a value in the `Result`-shaped IPC envelope `commands.*` returns. */
const ok = <T>(data: T) => ({ status: 'ok' as const, data })

const HEALTHY: MdnsStatus = { disabled: false, reason: null }
const DISABLED: MdnsStatus = { disabled: true, reason: 'multicast lock missing' }

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
  mockGetMdnsStatus.mockResolvedValue(ok(HEALTHY))
})

afterEach(() => {
  if (!hadTauriInternals) {
    delete (window as any).__TAURI_INTERNALS__
  }
})

function getListenerCallback(eventName: string): (event: { payload: unknown }) => void {
  const call = mockListen.mock.calls.find((c) => c[0] === eventName)
  if (!call) throw new Error(`No listener registered for "${eventName}"`)
  return call[1] as (event: { payload: unknown }) => void
}

describe('event-name constant pinned', () => {
  it('matches the Rust EVENT_SYNC_MDNS_DISABLED string', () => {
    // src-tauri/src/sync_events.rs hard-codes this — keep both in sync.
    expect(SYNC_MDNS_DISABLED_EVENT).toBe('sync:mdns_disabled')
  })
})

describe('useMdnsStatus — initial state', () => {
  it('starts healthy (not disabled)', async () => {
    const { result } = renderHook(() => useMdnsStatus())
    await waitFor(() => expect(mockGetMdnsStatus).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({ disabled: false, reason: null })
  })
})

describe('useMdnsStatus — live event', () => {
  it('registers a listener for sync:mdns_disabled when in Tauri', () => {
    renderHook(() => useMdnsStatus())
    expect(mockListen).toHaveBeenCalledWith(SYNC_MDNS_DISABLED_EVENT, expect.any(Function))
  })

  it('flips to disabled with the reason when the backend emits', () => {
    const { result } = renderHook(() => useMdnsStatus())
    act(() => {
      getListenerCallback(SYNC_MDNS_DISABLED_EVENT)({
        payload: { reason: 'iOS sandbox blocks UDP' },
      })
    })
    expect(result.current).toEqual({ disabled: true, reason: 'iOS sandbox blocks UDP' })
  })

  it('ignores a malformed event payload without throwing', () => {
    const { result } = renderHook(() => useMdnsStatus())
    const cb = getListenerCallback(SYNC_MDNS_DISABLED_EVENT)
    expect(() => act(() => cb({ payload: { not: 'a status' } }))).not.toThrow()
    expect(result.current).toEqual({ disabled: false, reason: null })
  })
})

describe('useMdnsStatus — mount backfill', () => {
  it('queries getMdnsStatus and adopts a disabled backfill', async () => {
    // The live event is emitted by the daemon before this listener
    // registers whenever peers already exist at boot, so the backfill is
    // the path that actually surfaces the disabled state in practice.
    mockGetMdnsStatus.mockResolvedValue(ok(DISABLED))
    const { result } = renderHook(() => useMdnsStatus())
    await waitFor(() => expect(mockGetMdnsStatus).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(result.current).toEqual({ disabled: true, reason: 'multicast lock missing' }),
    )
  })

  it('stays healthy when the backfill reports mDNS working', async () => {
    mockGetMdnsStatus.mockResolvedValue(ok(HEALTHY))
    const { result } = renderHook(() => useMdnsStatus())
    await waitFor(() => expect(mockGetMdnsStatus).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({ disabled: false, reason: null })
  })

  it('swallows a rejected backfill query', async () => {
    mockGetMdnsStatus.mockRejectedValue(new Error('ipc down'))
    const { result } = renderHook(() => useMdnsStatus())
    await waitFor(() => expect(mockGetMdnsStatus).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({ disabled: false, reason: null })
  })
})

describe('useMdnsStatus — browser mode', () => {
  it('no-ops when __TAURI_INTERNALS__ is absent', async () => {
    delete (window as any).__TAURI_INTERNALS__
    renderHook(() => useMdnsStatus())
    expect(mockListen).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(mockGetMdnsStatus).not.toHaveBeenCalled()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      writable: true,
      configurable: true,
    })
  })
})
