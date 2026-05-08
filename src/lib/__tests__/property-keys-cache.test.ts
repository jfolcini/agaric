/**
 * Tests for `src/lib/property-keys-cache.ts` (PEND-35 Tier 2.5).
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

function fireInvalidationEvent(): void {
  const handler = eventListeners.get(EVENT_PROPERTY_CHANGED)
  if (!handler) throw new Error(`${EVENT_PROPERTY_CHANGED} listener was never registered`)
  handler({ payload: { block_id: 'BLK01', changed_keys: ['project'] } })
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
  // (c) Invalidation event triggers a refetch on the next consumer
  // ------------------------------------------------------------------
  it('block:properties-changed invalidates the cache so the next fetch refetches', async () => {
    ensurePropertyKeysInvalidationListener()
    await fetchPropertyKeysOnce('SPACE_A')
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // Materializer signals that property data changed.
    fireInvalidationEvent()

    // Cached entry is dropped — snapshot resets to EMPTY.
    expect(getCachedPropertyKeys('SPACE_A')).toBe(PROPERTY_KEYS_EMPTY)

    // Next fetch fires a fresh IPC.
    mockedInvoke.mockResolvedValueOnce(['project', 'effort', 'assignee'])
    const refreshed = await fetchPropertyKeysOnce('SPACE_A')
    expect(refreshed).toEqual(['project', 'effort', 'assignee'])
    expect(listPropertyKeysInvocationCount()).toBe(2)
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
