/**
 * Tests for `usePropertyKeysCache`.
 *
 * Validates the four invariants pinned by the maintenance task:
 *  (a) two consecutive `usePropertyKeysCache(spaceId)` mounts fire ONE IPC,
 *  (b) different `spaceId`s fire separate IPCs,
 *  (c) the materializer `block:properties-changed` event invalidates the
 *      query so the active consumer refetches (#2596: the TanStack-backed
 *      cache invalidates + refetches rather than dropping to an empty
 *      snapshot, but the observable "consumer sees fresh data" intent holds),
 *  (d) a consumer mounted after invalidation sees the refreshed data.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const eventListeners = new Map<string, (event: unknown) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (eventName: string, handler: (event: unknown) => void): Promise<() => void> => {
      eventListeners.set(eventName, handler)
      return () => {
        eventListeners.delete(eventName)
      }
    },
  ),
}))

// The cache only registers its `block:properties-changed` listener
// when running inside Tauri. Stamp the marker so the lazy-init path
// hits the mocked `listen()` above.
;(window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {}

import {
  _resetPropertyKeysCacheForTest,
  invalidatePropertyKeysCache,
  usePropertyKeysCache,
} from '@/hooks/usePropertyKeysCache'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  eventListeners.clear()
  _resetPropertyKeysCacheForTest()
  mockedInvoke.mockResolvedValue(['project', 'effort'])
})

afterEach(() => {
  _resetPropertyKeysCacheForTest()
})

function listPropertyKeysInvocationCount(): number {
  return mockedInvoke.mock.calls.filter((c) => c[0] === 'list_property_keys').length
}

// Default to a key the cache has never seen so the #2507 keyed-invalidation
// strategy treats it as a distinct-key-list change and clears the cache. Pass
// only already-known keys to exercise the skip-when-no-new-key path.
function fireInvalidationEvent(changedKeys: string[] = ['assignee']): void {
  const handler = eventListeners.get('block:properties-changed')
  if (!handler) throw new Error('block:properties-changed listener was never registered')
  handler({ payload: { block_id: 'BLK01', changed_keys: changedKeys } })
}

describe('usePropertyKeysCache', () => {
  // ------------------------------------------------------------------
  // (a) Two consecutive mounts fire ONE IPC
  // ------------------------------------------------------------------
  it('shares one IPC fetch across two consecutive mounts of the same spaceId', async () => {
    const { result: r1 } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    const { result: r2 } = renderHook(() => usePropertyKeysCache('SPACE_A'))

    await waitFor(() => {
      expect(r1.current).toEqual(['project', 'effort'])
      expect(r2.current).toEqual(['project', 'effort'])
    })

    expect(listPropertyKeysInvocationCount()).toBe(1)
  })

  it('shares the same cached array across remounts (no extra IPC after the first fetch resolves)', async () => {
    const { result: r1, unmount } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(r1.current).toEqual(['project', 'effort'])
    })
    unmount()

    const { result: r2 } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    // Cache hit — value available synchronously on first render.
    expect(r2.current).toEqual(['project', 'effort'])
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })

  // ------------------------------------------------------------------
  // (b) Different spaceIds fire separate IPCs
  // ------------------------------------------------------------------
  it('fetches independently for different spaceIds', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_property_keys') return ['key-from-current-space']
      return undefined
    })

    const { result: rA } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    const { result: rB } = renderHook(() => usePropertyKeysCache('SPACE_B'))

    await waitFor(() => {
      expect(rA.current).toEqual(['key-from-current-space'])
      expect(rB.current).toEqual(['key-from-current-space'])
    })

    expect(listPropertyKeysInvocationCount()).toBe(2)
  })

  it('treats a null spaceId as a distinct cache slot', async () => {
    const { result: rNull } = renderHook(() => usePropertyKeysCache(null))
    const { result: rA } = renderHook(() => usePropertyKeysCache('SPACE_A'))

    await waitFor(() => {
      expect(rNull.current).toEqual(['project', 'effort'])
      expect(rA.current).toEqual(['project', 'effort'])
    })

    expect(listPropertyKeysInvocationCount()).toBe(2)
  })

  // ------------------------------------------------------------------
  // (c) Invalidation event clears the cache
  // ------------------------------------------------------------------
  it('refetches when block:properties-changed introduces a new key', async () => {
    const { result } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(result.current).toEqual(['project', 'effort'])
    })
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // The Tauri listener was registered on first mount — fire the
    // materializer event with a NEW key and confirm the active consumer
    // refetches the refreshed key list (#2507 keyed invalidation).
    mockedInvoke.mockResolvedValue(['project', 'effort', 'assignee'])
    act(() => {
      fireInvalidationEvent(['assignee'])
    })

    await waitFor(() => {
      expect(result.current).toEqual(['project', 'effort', 'assignee'])
    })
    expect(listPropertyKeysInvocationCount()).toBe(2)
  })

  it('does NOT clear the cache when block:properties-changed only touches known keys (#2507)', async () => {
    const { result } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(result.current).toEqual(['project', 'effort'])
    })
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // A write to an already-known key can't change the distinct-key list, so
    // the strategy skips invalidation and the cache stays populated.
    act(() => {
      fireInvalidationEvent(['project'])
    })

    expect(result.current).toEqual(['project', 'effort'])
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })

  it('exposes invalidatePropertyKeysCache() for non-event callers', async () => {
    const { result } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(result.current).toEqual(['project', 'effort'])
    })

    mockedInvoke.mockResolvedValue(['project', 'effort', 'assignee'])
    act(() => {
      invalidatePropertyKeysCache()
    })

    await waitFor(() => {
      expect(result.current).toEqual(['project', 'effort', 'assignee'])
    })
    expect(listPropertyKeysInvocationCount()).toBe(2)
  })

  // ------------------------------------------------------------------
  // (d) Third consumer mounted after invalidation refetches
  // ------------------------------------------------------------------
  it('a consumer mounted after invalidation sees the refreshed data', async () => {
    // First two consumers share a single fetch (invariant a).
    const { result: r1 } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    const { result: r2 } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(r1.current).toEqual(['project', 'effort'])
      expect(r2.current).toEqual(['project', 'effort'])
    })
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // Materializer signals that a new property key appeared — the active
    // observers refetch through the shared query (a single fresh IPC).
    mockedInvoke.mockResolvedValue(['project', 'effort', 'assignee'])
    act(() => {
      fireInvalidationEvent(['assignee'])
    })

    // Third consumer mounts post-invalidation — reuses the shared refreshed
    // query rather than firing its own IPC.
    const { result: r3 } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(r3.current).toEqual(['project', 'effort', 'assignee'])
    })

    expect(listPropertyKeysInvocationCount()).toBe(2)
  })

  // ------------------------------------------------------------------
  // Misc: error path falls back to empty array
  // ------------------------------------------------------------------
  it('falls back to an empty array when listPropertyKeys rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failure'))

    const { result } = renderHook(() => usePropertyKeysCache('SPACE_A'))

    await waitFor(() => {
      expect(listPropertyKeysInvocationCount()).toBe(1)
    })

    // The hook caches the empty fallback so a second consumer doesn't
    // re-trigger the failing IPC.
    const { result: r2 } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(r2.current).toEqual([])
    })
    expect(result.current).toEqual([])
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })
})
