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
import type { OsNetworkBlockStatus } from '@/lib/bindings'
import { sync as syncCatalog } from '@/lib/i18n/sync'

const { mockUnlisten, mockListen, mockGetOsNetworkBlockStatus } = vi.hoisted(() => {
  const unlisten = vi.fn()
  const listen = vi.fn().mockResolvedValue(unlisten)
  const getOsNetworkBlockStatus = vi.fn()
  return {
    mockUnlisten: unlisten,
    mockListen: listen,
    mockGetOsNetworkBlockStatus: getOsNetworkBlockStatus,
  }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

vi.mock('@/lib/bindings', () => ({
  commands: {
    getOsNetworkBlockStatus: (...args: unknown[]) => mockGetOsNetworkBlockStatus(...args),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

/** Wrap a value in the `Result`-shaped IPC envelope `commands.*` returns. */
const ok = <T>(data: T) => ({ status: 'ok' as const, data })

const NOT_BLOCKED: OsNetworkBlockStatus = { blocked: false, reason_key: null }
const BLOCKED: OsNetworkBlockStatus = {
  blocked: true,
  reason_key: 'pairing.osNetworkBlocked',
}

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
  mockGetOsNetworkBlockStatus.mockResolvedValue(ok(NOT_BLOCKED))
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

/**
 * #4035 — the mount-time read of the CURRENT status.
 *
 * The daemon emits only on a transition and dedups process-globally, so the
 * second time the pairing dialog is opened during one continuous block there is
 * no event to hear. Everything below is about that dialog session: the banner
 * has to appear from a query, and the query must not be able to invent, latch,
 * or resurrect a block.
 */
describe('useOsNetworkBlock — mount-time query', () => {
  it('asks the daemon what is true now when it mounts', async () => {
    renderHook(() => useOsNetworkBlock())
    await waitFor(() => expect(mockGetOsNetworkBlockStatus).toHaveBeenCalledTimes(1))
  })

  it('does not query outside Tauri, where no daemon can answer', async () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    const { result } = renderHook(() => useOsNetworkBlock())
    await Promise.resolve()
    expect(mockGetOsNetworkBlockStatus).not.toHaveBeenCalled()
    expect(result.current).toEqual({ blocked: false, reasonKey: null })
  })

  /**
   * The regression this issue exists for: a block that started before this
   * dialog mounted. No event will arrive — the daemon already reported it, to a
   * listener that unmounted with the previous dialog session — so if the query
   * does not raise the banner, nothing does, and the user is shown a clean UI on
   * a device whose network is cut.
   */
  it('shows a block that was already in progress before it mounted', async () => {
    mockGetOsNetworkBlockStatus.mockResolvedValue(ok(BLOCKED))

    const { result } = renderHook(() => useOsNetworkBlock())

    await waitFor(() => {
      expect(result.current).toEqual({
        blocked: true,
        reasonKey: 'pairing.osNetworkBlocked',
      })
    })
  })

  it('does not invent a block when the daemon says the network is fine', async () => {
    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => expect(mockGetOsNetworkBlockStatus).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({ blocked: false, reasonKey: null })
  })

  /**
   * Same contract the live-event validator enforces, on the other input: a
   * block with no key names no catalog entry, and the hook has no fallback
   * wording, so honouring it would render an empty banner.
   */
  it('rejects a queried block that names no key rather than inventing one', async () => {
    mockGetOsNetworkBlockStatus.mockResolvedValue(ok({ blocked: true, reason_key: null }))

    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => expect(mockGetOsNetworkBlockStatus).toHaveBeenCalledTimes(1))

    expect(result.current).toEqual({ blocked: false, reasonKey: null })
  })

  /**
   * The stale-answer case #4034 was right to worry about, in the only form it
   * can still take: the query and the first live event race by one IPC round
   * trip. If the event wins, it is the newer fact and the query's answer must be
   * dropped — otherwise a mount-time read resurrects a block the user just
   * watched clear, which is exactly the small lie the earlier note refused.
   */
  it('lets a live recovery win over a query still in flight', async () => {
    let resolveQuery: (value: unknown) => void = () => {}
    mockGetOsNetworkBlockStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve
      }),
    )

    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(SYNC_NETWORK_BLOCKED_EVENT, expect.any(Function))
    })

    // The daemon reports the recovery while the query is still unresolved…
    await emit({ blocked: false, reason_key: null })
    expect(result.current).toEqual({ blocked: false, reasonKey: null })

    // …and only then does the older read come back saying "blocked".
    await act(async () => {
      resolveQuery(ok(BLOCKED))
      await Promise.resolve()
    })

    expect(result.current).toEqual({ blocked: false, reasonKey: null })
  })

  /**
   * A block the query cannot answer for is not a reason to break the dialog.
   * The live event path is unaffected, so the hook degrades to exactly the
   * behaviour it had before #4035.
   */
  it('survives a rejected query and still reports a later live block', async () => {
    mockGetOsNetworkBlockStatus.mockRejectedValue(new Error('IPC is down'))

    const { result } = renderHook(() => useOsNetworkBlock())
    await waitFor(() => expect(mockGetOsNetworkBlockStatus).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({ blocked: false, reasonKey: null })

    await emit({ blocked: true, reason_key: 'pairing.osNetworkBlocked' })
    expect(result.current).toEqual({ blocked: true, reasonKey: 'pairing.osNetworkBlocked' })
  })
})
