/**
 * Tests for `src/lib/property-keys-cache.ts`.
 *
 * The cache primitives moved out of `usePropertyKeysCache` so non-React
 * callers (slash-command picker) can share the same module-level state.
 * The hook keeps its own coverage for React-specific behaviour
 * (`useSyncExternalStore` snapshot stability, mount/unmount). This file
 * pins the plain-JS contract:
 *
 *  (a) module-level cache hit — second call returns cached array
 *      without firing a fresh IPC,
 *  (b) in-flight dedupe — two concurrent calls share one IPC,
 *  (c) `block:properties-changed` invalidation triggers a refetch on
 *      the next consumer.
 */

import { invoke } from '@tauri-apps/api/core'
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
  EVENT_PROPERTY_CHANGED,
  ensurePropertyKeysInvalidationListener,
  fetchPropertyKeysOnce,
  getCachedPropertyKeys,
  getPropertyKeys,
  invalidatePropertyKeysCache,
  PROPERTY_KEYS_EMPTY,
  subscribeToPropertyKeysCache,
} from '../property-keys-cache'

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

function fireInvalidationEvent(changedKeys: string[] = ['assignee']): void {
  const handler = eventListeners.get(EVENT_PROPERTY_CHANGED)
  if (!handler) throw new Error(`${EVENT_PROPERTY_CHANGED} listener was never registered`)
  handler({ payload: { block_id: 'BLK01', changed_keys: changedKeys } })
}

describe('property-keys-cache', () => {
  // ------------------------------------------------------------------
  // (a) Module-level cache hit
  // ------------------------------------------------------------------
  it('caches the result so a second fetch reuses the cached array without firing IPC', async () => {
    const first = await fetchPropertyKeysOnce('SPACE_A')
    expect(first).toEqual(['project', 'effort'])
    expect(listPropertyKeysInvocationCount()).toBe(1)

    const second = await fetchPropertyKeysOnce('SPACE_A')
    expect(second).toBe(first) // same array reference — cached
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })

  it('getCachedPropertyKeys returns the stable EMPTY array before the first fetch', () => {
    expect(getCachedPropertyKeys('SPACE_A')).toBe(PROPERTY_KEYS_EMPTY)
  })

  it('different spaceKeys cache independently and fire separate IPCs', async () => {
    await fetchPropertyKeysOnce('SPACE_A')
    await fetchPropertyKeysOnce('SPACE_B')
    expect(listPropertyKeysInvocationCount()).toBe(2)
  })

  // ------------------------------------------------------------------
  // (b) In-flight dedupe — two concurrent calls share one IPC
  // ------------------------------------------------------------------
  it('two concurrent fetchPropertyKeysOnce() calls share a single IPC', async () => {
    let resolveIpc: ((keys: string[]) => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveIpc = resolve
        }),
    )

    const p1 = fetchPropertyKeysOnce('SPACE_A')
    const p2 = fetchPropertyKeysOnce('SPACE_A')

    // Both calls registered before the IPC resolved — only one IPC fired.
    expect(listPropertyKeysInvocationCount()).toBe(1)

    if (!resolveIpc) throw new Error('resolveIpc was never assigned')
    ;(resolveIpc as (keys: string[]) => void)(['project', 'effort'])

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual(['project', 'effort'])
    expect(r2).toEqual(['project', 'effort'])
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })

  // ------------------------------------------------------------------
  // (c) An event that introduces a NEW key invalidates the cache so the
  //     next fetch refetches (#2507 keyed invalidation — the distinct-key
  //     list can only change when a key not already known appears).
  // ------------------------------------------------------------------
  it('block:properties-changed with a NEW key invalidates the cache so the next fetch refetches', async () => {
    ensurePropertyKeysInvalidationListener()
    await fetchPropertyKeysOnce('SPACE_A') // caches ['project', 'effort']
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // A write introduces a key the cache has never seen.
    fireInvalidationEvent(['assignee'])

    // Cached entry is dropped — snapshot resets to EMPTY.
    expect(getCachedPropertyKeys('SPACE_A')).toBe(PROPERTY_KEYS_EMPTY)

    // Next fetch fires a fresh IPC.
    mockedInvoke.mockResolvedValueOnce(['project', 'effort', 'assignee'])
    const refreshed = await fetchPropertyKeysOnce('SPACE_A')
    expect(refreshed).toEqual(['project', 'effort', 'assignee'])
    expect(listPropertyKeysInvocationCount()).toBe(2)
  })

  // ------------------------------------------------------------------
  // (c-reduced) #2507 reduced-wakeup: an event whose changed_keys are ALL
  //     already-known keys cannot change the distinct-key list, so the
  //     cache is left intact and NO refetch fires on the next consumer.
  // ------------------------------------------------------------------
  it('block:properties-changed with only already-known keys does NOT invalidate (no refetch)', async () => {
    ensurePropertyKeysInvalidationListener()
    const cached = await fetchPropertyKeysOnce('SPACE_A') // caches ['project', 'effort']
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // A write only touches keys the cache already knows about.
    fireInvalidationEvent(['project', 'effort'])

    // Cache untouched — same array reference, still populated.
    expect(getCachedPropertyKeys('SPACE_A')).toBe(cached)

    // The next consumer reuses the cached array without a fresh IPC.
    const again = await fetchPropertyKeysOnce('SPACE_A')
    expect(again).toBe(cached)
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })

  // ------------------------------------------------------------------
  // (c') Invalidation that races an in-flight fetch must NOT write the
  //      stale pre-change snapshot back after the clear (#2025).
  // ------------------------------------------------------------------
  it('does not cache a stale result when invalidation races an in-flight fetch', async () => {
    let resolveIpc: ((keys: string[]) => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveIpc = resolve
        }),
    )

    // Start a fetch — IPC is in flight, not yet resolved.
    const inflight = fetchPropertyKeysOnce('SPACE_A')
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // A property changes mid-flight: cache is invalidated.
    invalidatePropertyKeysCache()
    expect(getCachedPropertyKeys('SPACE_A')).toBe(PROPERTY_KEYS_EMPTY)

    // Now the original IPC resolves with the pre-change snapshot.
    if (!resolveIpc) throw new Error('resolveIpc was never assigned')
    ;(resolveIpc as (keys: string[]) => void)(['project', 'effort'])
    await inflight

    // The stale snapshot must NOT have been written back — the cache
    // stays empty so the next consumer triggers a fresh fetch.
    expect(getCachedPropertyKeys('SPACE_A')).toBe(PROPERTY_KEYS_EMPTY)

    // A subsequent fetch fires a fresh IPC and gets the new data.
    mockedInvoke.mockResolvedValueOnce(['project', 'effort', 'assignee'])
    const refreshed = await fetchPropertyKeysOnce('SPACE_A')
    expect(refreshed).toEqual(['project', 'effort', 'assignee'])
    expect(getCachedPropertyKeys('SPACE_A')).toEqual(['project', 'effort', 'assignee'])
    expect(listPropertyKeysInvocationCount()).toBe(2)
  })

  it('does not cache the empty error fallback when invalidation races a failing fetch', async () => {
    let rejectIpc: ((err: Error) => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectIpc = reject
        }),
    )

    const inflight = fetchPropertyKeysOnce('SPACE_A')
    expect(listPropertyKeysInvocationCount()).toBe(1)

    invalidatePropertyKeysCache()

    if (!rejectIpc) throw new Error('rejectIpc was never assigned')
    ;(rejectIpc as (err: Error) => void)(new Error('IPC failure'))
    await inflight

    // The empty fallback from the raced fetch must not be cached either.
    expect(getCachedPropertyKeys('SPACE_A')).toBe(PROPERTY_KEYS_EMPTY)
  })

  it('invalidatePropertyKeysCache() clears every cached spaceKey', async () => {
    await fetchPropertyKeysOnce('SPACE_A')
    await fetchPropertyKeysOnce('SPACE_B')
    expect(listPropertyKeysInvocationCount()).toBe(2)

    invalidatePropertyKeysCache()
    expect(getCachedPropertyKeys('SPACE_A')).toBe(PROPERTY_KEYS_EMPTY)
    expect(getCachedPropertyKeys('SPACE_B')).toBe(PROPERTY_KEYS_EMPTY)
  })

  // ------------------------------------------------------------------
  // Subscriber notifications
  // ------------------------------------------------------------------
  it('notifies subscribers when an in-flight fetch resolves', async () => {
    const cb = vi.fn()
    const unsub = subscribeToPropertyKeysCache(cb)

    await fetchPropertyKeysOnce('SPACE_A')
    expect(cb).toHaveBeenCalled()

    unsub()
    cb.mockClear()
    invalidatePropertyKeysCache()
    expect(cb).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // Error path falls back to empty array (matches pre-cache behaviour)
  // ------------------------------------------------------------------
  it('falls back to an empty array when listPropertyKeys rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failure'))
    const result = await fetchPropertyKeysOnce('SPACE_A')
    expect(result).toEqual([])
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // The cache remembers the empty fallback so a second consumer
    // doesn't re-trigger the failing IPC immediately.
    const second = await fetchPropertyKeysOnce('SPACE_A')
    expect(second).toEqual([])
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })

  // ------------------------------------------------------------------
  // getPropertyKeys() — convenience for non-React callers
  // ------------------------------------------------------------------
  it('getPropertyKeys() returns the cached array without a second IPC', async () => {
    const first = await getPropertyKeys('SPACE_A')
    const second = await getPropertyKeys('SPACE_A')
    expect(first).toBe(second)
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })
})
