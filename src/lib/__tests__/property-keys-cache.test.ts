/**
 * Tests for `src/lib/property-keys-cache.ts` (#2596 — TanStack Query-backed).
 *
 * The hand-rolled Map/in-flight/subscriber cache is gone; the module is now a
 * thin wrapper over the shared `queryClient` singleton. These tests pin the
 * queryClient-backed contract while preserving behavioural intent:
 *
 *  (a) cache hit — a second `fetchPropertyKeysOnce` for the same key fires
 *      only ONE `list_property_keys` IPC,
 *  (b) in-flight dedupe — two concurrent calls share one IPC,
 *  (c) event invalidation — a `block:properties-changed` with a NEW key
 *      invalidates so the next fetch refetches,
 *  (d) skip-when-no-new-key (#2507) — an event whose changed_keys are all
 *      already-known does NOT invalidate (no refetch),
 *  (e) error → `[]` fallback is returned and cached.
 */

import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@/lib/query-client'

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

// The invalidation listener only registers its `block:properties-changed`
// subscription when running inside Tauri. Stamp the marker so the lazy-init
// path hits the mocked `listen()` above.
;(window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {}

import {
  _resetPropertyKeysCacheForTest,
  EVENT_PROPERTY_CHANGED,
  ensurePropertyKeysInvalidationListener,
  fetchPropertyKeysOnce,
  getPropertyKeys,
  invalidatePropertyKeysCache,
  propertyKeysQueryKey,
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
  // (a) Cache hit — a second fetch reuses the cached array, no new IPC
  // ------------------------------------------------------------------
  it('caches the result so a second fetch reuses the cached array without firing IPC', async () => {
    const first = await fetchPropertyKeysOnce('SPACE_A')
    expect(first).toEqual(['project', 'effort'])
    expect(listPropertyKeysInvocationCount()).toBe(1)

    const second = await fetchPropertyKeysOnce('SPACE_A')
    expect(second).toBe(first) // same array reference — cached
    expect(listPropertyKeysInvocationCount()).toBe(1)
    expect(queryClient.getQueryData(propertyKeysQueryKey('SPACE_A'))).toEqual(['project', 'effort'])
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
  //     next fetch refetches (#2507 skip-when-no-new-key — the distinct-key
  //     list can only change when a key not already known appears).
  // ------------------------------------------------------------------
  it('block:properties-changed with a NEW key invalidates so the next fetch refetches', async () => {
    ensurePropertyKeysInvalidationListener()
    await fetchPropertyKeysOnce('SPACE_A') // caches ['project', 'effort']
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // A write introduces a key the cache has never seen.
    fireInvalidationEvent(['assignee'])

    // The query is marked stale/invalidated.
    expect(queryClient.getQueryState(propertyKeysQueryKey('SPACE_A'))?.isInvalidated).toBe(true)

    // Next fetch fires a fresh IPC.
    mockedInvoke.mockResolvedValueOnce(['project', 'effort', 'assignee'])
    const refreshed = await fetchPropertyKeysOnce('SPACE_A')
    expect(refreshed).toEqual(['project', 'effort', 'assignee'])
    expect(listPropertyKeysInvocationCount()).toBe(2)
  })

  // ------------------------------------------------------------------
  // (d) #2507 reduced-wakeup: an event whose changed_keys are ALL
  //     already-known keys cannot change the distinct-key list, so the
  //     cache is left intact and NO refetch fires on the next consumer.
  // ------------------------------------------------------------------
  it('block:properties-changed with only already-known keys does NOT invalidate (no refetch)', async () => {
    ensurePropertyKeysInvalidationListener()
    const cached = await fetchPropertyKeysOnce('SPACE_A') // caches ['project', 'effort']
    expect(listPropertyKeysInvocationCount()).toBe(1)

    // A write only touches keys the cache already knows about.
    fireInvalidationEvent(['project', 'effort'])

    // Cache untouched — not invalidated.
    expect(queryClient.getQueryState(propertyKeysQueryKey('SPACE_A'))?.isInvalidated).toBe(false)

    // The next consumer reuses the cached array without a fresh IPC.
    const again = await fetchPropertyKeysOnce('SPACE_A')
    expect(again).toBe(cached)
    expect(listPropertyKeysInvocationCount()).toBe(1)
  })

  it('invalidatePropertyKeysCache() invalidates every cached spaceKey so they refetch', async () => {
    await fetchPropertyKeysOnce('SPACE_A')
    await fetchPropertyKeysOnce('SPACE_B')
    expect(listPropertyKeysInvocationCount()).toBe(2)

    invalidatePropertyKeysCache()
    expect(queryClient.getQueryState(propertyKeysQueryKey('SPACE_A'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(propertyKeysQueryKey('SPACE_B'))?.isInvalidated).toBe(true)

    await fetchPropertyKeysOnce('SPACE_A')
    await fetchPropertyKeysOnce('SPACE_B')
    expect(listPropertyKeysInvocationCount()).toBe(4)
  })

  // ------------------------------------------------------------------
  // (e) Error path falls back to empty array, and the fallback is cached
  //     (matches the pre-migration behaviour of caching `[]` on failure).
  // ------------------------------------------------------------------
  it('falls back to an empty array when listPropertyKeys rejects and caches it', async () => {
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
