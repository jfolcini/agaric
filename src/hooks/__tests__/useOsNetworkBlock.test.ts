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

import {
  OS_NETWORK_BLOCKED_REASON_KEY,
  SYNC_NETWORK_BLOCKED_EVENT,
  useOsNetworkBlock,
} from '@/hooks/useOsNetworkBlock'
import { sync as syncCatalog } from '@/lib/i18n/sync'

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
    expect(result.current).toEqual({ blocked: false, reasonKey: null })
  })

  it('reports the block, carrying the daemon’s translation KEY, when the OS says so', async () => {
    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(SYNC_NETWORK_BLOCKED_EVENT, expect.any(Function))
    })

    // Byte-for-byte the payload `blocked_transition` produces in
    // `android_network_block.rs` — a key, never prose.
    await emit({ blocked: true, reason_key: 'pairing.osNetworkBlocked' })

    expect(result.current).toEqual({ blocked: true, reasonKey: 'pairing.osNetworkBlocked' })
  })

  /**
   * The cross-language pin. The daemon hardcodes this key in
   * `BLOCKED_REASON_KEY` (`android_network_block.rs`, pinned there by the same
   * literal); nothing but this test stops the catalog entry being renamed out
   * from under it, and i18next answers a missing key by rendering the key
   * itself — i.e. the user would see `pairing.osNetworkBlocked` on screen.
   */
  it('the key the daemon sends resolves to a real catalog entry', () => {
    expect(OS_NETWORK_BLOCKED_REASON_KEY).toBe('pairing.osNetworkBlocked')
    expect(syncCatalog[OS_NETWORK_BLOCKED_REASON_KEY]).toBeTypeOf('string')
    expect(syncCatalog[OS_NETWORK_BLOCKED_REASON_KEY]).not.toBe('')
  })

  it('clears when the OS restores access, so the warning does not outlive the block', async () => {
    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(SYNC_NETWORK_BLOCKED_EVENT, expect.any(Function))
    })

    await emit({ blocked: true, reason_key: 'pairing.osNetworkBlocked' })
    expect(result.current.blocked).toBe(true)

    // The recovery carries no key: it removes the banner, so there is no text
    // to show and a key would be dead weight.
    await emit({ blocked: false, reason_key: null })
    expect(result.current).toEqual({ blocked: false, reasonKey: null })
  })

  it('ignores a malformed payload rather than rendering a block with no reason', async () => {
    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(SYNC_NETWORK_BLOCKED_EVENT, expect.any(Function))
    })

    await emit({ blocked: 'yes' })

    expect(result.current).toEqual({ blocked: false, reasonKey: null })
  })

  /**
   * A block with no key is malformed, not a block with a default. Accepting it
   * would put an empty (or key-shaped) banner on screen; the hook has no
   * fallback string to reach for, by design — the daemon is the only source of
   * the key, so "blocked with no key" is a contract violation, not a state.
   */
  it('rejects a block that names no key rather than inventing one', async () => {
    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(SYNC_NETWORK_BLOCKED_EVENT, expect.any(Function))
    })

    await emit({ blocked: true, reason_key: null })

    expect(result.current).toEqual({ blocked: false, reasonKey: null })
  })
})
