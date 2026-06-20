/**
 * Tests for `usePropertyKeysCache`.
 *
 * Validates the four invariants pinned by the maintenance task:
 *  (a) two consecutive `usePropertyKeysCache(spaceId)` mounts fire ONE IPC,
 *  (b) different `spaceId`s fire separate IPCs,
 *  (c) the materializer `block:properties-changed` event clears the cache,
 *  (d) a third consumer mounted after invalidation refetches.
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
} from '../usePropertyKeysCache'

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

function fireInvalidationEvent(): void {
  const handler = eventListeners.get('block:properties-changed')
  if (!handler) throw new Error('block:properties-changed listener was never registered')
  handler({ payload: { block_id: 'BLK01', changed_keys: ['project'] } })
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
  it('clears the cache when block:properties-changed fires', async () => {
    const { result } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(result.current).toEqual(['project', 'effort'])
    })
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // The Tauri listener was registered on first mount — fire the
    // materializer event and confirm the cached entry is dropped.
    act(() => {
      fireInvalidationEvent()
    })

    // Snapshot resets to empty until a fresh consumer triggers a refetch.
    expect(result.current).toEqual([])
  })

  it('exposes invalidatePropertyKeysCache() for non-event callers', async () => {
    const { result } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(result.current).toEqual(['project', 'effort'])
    })

    act(() => {
      invalidatePropertyKeysCache()
    })

    expect(result.current).toEqual([])
  })

  // ------------------------------------------------------------------
  // (d) Third consumer mounted after invalidation refetches
  // ------------------------------------------------------------------
  it('a consumer mounted after invalidation triggers a fresh IPC fetch', async () => {
    // First two consumers share a single fetch (invariant a).
    const { result: r1 } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    const { result: r2 } = renderHook(() => usePropertyKeysCache('SPACE_A'))
    await waitFor(() => {
      expect(r1.current).toEqual(['project', 'effort'])
      expect(r2.current).toEqual(['project', 'effort'])
    })
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // Materializer signals that property data changed.
    act(() => {
      fireInvalidationEvent()
    })

    // Third consumer mounts post-invalidation — must trigger refetch.
    mockedInvoke.mockResolvedValue(['project', 'effort', 'assignee'])
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
