/**
 * Tests for useOsNetworkBlock (#3852).
 *
 * The point of this hook is that a firewall block STOPS being inferred from
 * silence. So the assertions are about the block being reported when the daemon
 * says so, cleared when the daemon says so, and never invented otherwise — a
 * hook that latched, or that guessed from an absent event, would put a "keep
 * your screen on" warning in front of users whose network is fine.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SYNC_NETWORK_BLOCKED_EVENT, useOsNetworkBlock } from '@/hooks/useOsNetworkBlock'

const { mockUnlisten, mockListen } = vi.hoisted(() => {
  const unlisten = vi.fn()
  const listen = vi.fn().mockResolvedValue(unlisten)
  return { mockUnlisten: unlisten, mockListen: listen }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

let hadTauriInternals: boolean

/** Deliver a payload through the registered `sync:network_blocked` handler. */
async function emit(payload: unknown) {
  const call = mockListen.mock.calls.find((c) => c[0] === SYNC_NETWORK_BLOCKED_EVENT)
  const handler = call?.[1] as ((e: { payload: unknown }) => void) | undefined
  expect(handler, 'the hook must register a sync:network_blocked listener').toBeTypeOf('function')
  await act(async () => {
    handler?.({ payload })
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListen.mockResolvedValue(mockUnlisten)
  hadTauriInternals = '__TAURI_INTERNALS__' in window
  if (!hadTauriInternals) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  }
})

afterEach(() => {
  if (!hadTauriInternals) {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  }
})

describe('useOsNetworkBlock', () => {
  it('starts clear — a block is never assumed', () => {
    const { result } = renderHook(() => useOsNetworkBlock())
    expect(result.current).toEqual({ blocked: false, reason: null })
  })

  it('reports the block, with the daemon’s reason, when the OS says so', async () => {
    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(SYNC_NETWORK_BLOCKED_EVENT, expect.any(Function))
    })

    await emit({
      blocked: true,
      reason: 'Android has paused this app’s network access because it is not in the foreground.',
    })

    expect(result.current.blocked).toBe(true)
    expect(result.current.reason).toContain('paused this app’s network access')
  })

  it('clears when the OS restores access, so the warning does not outlive the block', async () => {
    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(SYNC_NETWORK_BLOCKED_EVENT, expect.any(Function))
    })

    await emit({ blocked: true, reason: 'blocked' })
    expect(result.current.blocked).toBe(true)

    await emit({ blocked: false, reason: 'restored' })
    expect(result.current).toEqual({ blocked: false, reason: null })
  })

  it('ignores a malformed payload rather than rendering a block with no reason', async () => {
    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(SYNC_NETWORK_BLOCKED_EVENT, expect.any(Function))
    })

    await emit({ blocked: 'yes' })

    expect(result.current).toEqual({ blocked: false, reason: null })
  })
})
