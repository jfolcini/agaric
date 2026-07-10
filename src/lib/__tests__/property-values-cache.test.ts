/**
 * Tests for `src/lib/property-values-cache.ts`.
 *
 * Modelled on `property-keys-cache.test.ts` — the value cache is a
 * near-duplicate of the key cache, differing only in the cache
 * dimension (the property *key* rather than the *space id*) and the
 * backing IPC (`list_property_values` rather than `list_property_keys`).
 * This file pins the same plain-JS contract:
 *
 *  (a) module-level cache hit — second call returns cached array
 *      without firing a fresh IPC,
 *  (b) in-flight dedupe — two concurrent calls share one IPC,
 *  (c) `block:properties-changed` invalidation triggers a refetch on
 *      the next consumer,
 *  (c') an invalidation that races an in-flight fetch must NOT write
 *      the stale pre-change snapshot back after the clear (#2025).
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
  _resetPropertyValuesCacheForTest,
  EVENT_PROPERTY_CHANGED,
  ensurePropertyValuesInvalidationListener,
  fetchPropertyValuesOnce,
  getCachedPropertyValues,
  invalidatePropertyValuesCache,
  PROPERTY_VALUES_EMPTY,
  subscribeToPropertyValuesCache,
} from '../property-values-cache'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  eventListeners.clear()
  _resetPropertyValuesCacheForTest()
  mockedInvoke.mockResolvedValue(['alpha', 'beta'])
})

afterEach(() => {
  _resetPropertyValuesCacheForTest()
})

function listPropertyValuesInvocationCount(): number {
  return mockedInvoke.mock.calls.filter((c) => c[0] === 'list_property_values').length
}

function fireInvalidationEvent(): void {
  const handler = eventListeners.get(EVENT_PROPERTY_CHANGED)
  if (!handler) throw new Error(`${EVENT_PROPERTY_CHANGED} listener was never registered`)
  handler({ payload: { block_id: 'BLK01', changed_keys: ['project'] } })
}

describe('property-values-cache', () => {
  // ------------------------------------------------------------------
  // (a) Module-level cache hit
  // ------------------------------------------------------------------
  it('caches the result so a second fetch reuses the cached array without firing IPC', async () => {
    const first = await fetchPropertyValuesOnce('project')
    expect(first).toEqual(['alpha', 'beta'])
    expect(listPropertyValuesInvocationCount()).toBe(1)

    const second = await fetchPropertyValuesOnce('project')
    expect(second).toBe(first) // same array reference — cached
    expect(listPropertyValuesInvocationCount()).toBe(1)
  })

  it('getCachedPropertyValues returns the stable EMPTY array before the first fetch', () => {
    expect(getCachedPropertyValues('project')).toBe(PROPERTY_VALUES_EMPTY)
  })

  it('different keys cache independently and fire separate IPCs', async () => {
    await fetchPropertyValuesOnce('project')
    await fetchPropertyValuesOnce('effort')
    expect(listPropertyValuesInvocationCount()).toBe(2)
  })

  // ------------------------------------------------------------------
  // (b) In-flight dedupe — two concurrent calls share one IPC
  // ------------------------------------------------------------------
  it('two concurrent fetchPropertyValuesOnce() calls share a single IPC', async () => {
    let resolveIpc: ((values: string[]) => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveIpc = resolve
        }),
    )

    const p1 = fetchPropertyValuesOnce('project')
    const p2 = fetchPropertyValuesOnce('project')

    // Both calls registered before the IPC resolved — only one IPC fired.
    expect(listPropertyValuesInvocationCount()).toBe(1)

    if (!resolveIpc) throw new Error('resolveIpc was never assigned')
    ;(resolveIpc as (values: string[]) => void)(['alpha', 'beta'])

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual(['alpha', 'beta'])
    expect(r2).toEqual(['alpha', 'beta'])
    expect(listPropertyValuesInvocationCount()).toBe(1)
  })

  // ------------------------------------------------------------------
  // (c) Invalidation event triggers a refetch on the next consumer
  // ------------------------------------------------------------------
  it('block:properties-changed invalidates the cache so the next fetch refetches', async () => {
    ensurePropertyValuesInvalidationListener()
    await fetchPropertyValuesOnce('project')
    expect(listPropertyValuesInvocationCount()).toBe(1)

    // Materializer signals that property data changed.
    fireInvalidationEvent()

    // Cached entry is dropped — snapshot resets to EMPTY.
    expect(getCachedPropertyValues('project')).toBe(PROPERTY_VALUES_EMPTY)

    // Next fetch fires a fresh IPC.
    mockedInvoke.mockResolvedValueOnce(['alpha', 'beta', 'gamma'])
    const refreshed = await fetchPropertyValuesOnce('project')
    expect(refreshed).toEqual(['alpha', 'beta', 'gamma'])
    expect(listPropertyValuesInvocationCount()).toBe(2)
  })

  // ------------------------------------------------------------------
  // (c-reduced) #2507 keyed eviction: an event evicts ONLY the entries for
  //      its `changed_keys`; unrelated keys keep their cached array and fire
  //      no refetch. This is the reduced-wakeup property for the value cache.
  // ------------------------------------------------------------------
  it('evicts only the changed keys and leaves unrelated keys cached (#2507)', async () => {
    ensurePropertyValuesInvalidationListener()
    const project = await fetchPropertyValuesOnce('project')
    const effort = await fetchPropertyValuesOnce('effort')
    expect(listPropertyValuesInvocationCount()).toBe(2)

    // Only `project` changed.
    fireInvalidationEvent()

    // `project` is evicted; `effort` is untouched (same array reference).
    expect(getCachedPropertyValues('project')).toBe(PROPERTY_VALUES_EMPTY)
    expect(getCachedPropertyValues('effort')).toBe(effort)

    // A consumer of `effort` reuses the cached array — no fresh IPC. Only
    // `project` refetches.
    const effortAgain = await fetchPropertyValuesOnce('effort')
    expect(effortAgain).toBe(effort)
    expect(listPropertyValuesInvocationCount()).toBe(2)

    mockedInvoke.mockResolvedValueOnce(['alpha', 'beta', 'gamma'])
    const projectAgain = await fetchPropertyValuesOnce('project')
    expect(projectAgain).toEqual(['alpha', 'beta', 'gamma'])
    expect(projectAgain).not.toBe(project)
    expect(listPropertyValuesInvocationCount()).toBe(3)
  })

  // ------------------------------------------------------------------
  // (c') Invalidation that races an in-flight fetch must NOT write the
  //      stale pre-change snapshot back after the clear (#2025).
  // ------------------------------------------------------------------
  it('does not cache a stale result when invalidation races an in-flight fetch', async () => {
    let resolveIpc: ((values: string[]) => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveIpc = resolve
        }),
    )

    // Start a fetch — IPC is in flight, not yet resolved.
    const inflight = fetchPropertyValuesOnce('project')
    expect(listPropertyValuesInvocationCount()).toBe(1)

    // A property value changes mid-flight: cache is invalidated.
    invalidatePropertyValuesCache()
    expect(getCachedPropertyValues('project')).toBe(PROPERTY_VALUES_EMPTY)

    // Now the original IPC resolves with the pre-change snapshot.
    if (!resolveIpc) throw new Error('resolveIpc was never assigned')
    ;(resolveIpc as (values: string[]) => void)(['alpha', 'beta'])
    await inflight

    // The stale snapshot must NOT have been written back — the cache
    // stays empty so the next consumer triggers a fresh fetch.
    expect(getCachedPropertyValues('project')).toBe(PROPERTY_VALUES_EMPTY)

    // A subsequent fetch fires a fresh IPC and gets the new data.
    mockedInvoke.mockResolvedValueOnce(['alpha', 'beta', 'gamma'])
    const refreshed = await fetchPropertyValuesOnce('project')
    expect(refreshed).toEqual(['alpha', 'beta', 'gamma'])
    expect(getCachedPropertyValues('project')).toEqual(['alpha', 'beta', 'gamma'])
    expect(listPropertyValuesInvocationCount()).toBe(2)
  })

  it('does not cache the empty error fallback when invalidation races a failing fetch', async () => {
    let rejectIpc: ((err: Error) => void) | null = null
    mockedInvoke.mockImplementationOnce(
      () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectIpc = reject
        }),
    )

    const inflight = fetchPropertyValuesOnce('project')
    expect(listPropertyValuesInvocationCount()).toBe(1)

    invalidatePropertyValuesCache()

    if (!rejectIpc) throw new Error('rejectIpc was never assigned')
    ;(rejectIpc as (err: Error) => void)(new Error('IPC failure'))
    await inflight

    // The empty fallback from the raced fetch must not be cached either.
    expect(getCachedPropertyValues('project')).toBe(PROPERTY_VALUES_EMPTY)
  })

  it('invalidatePropertyValuesCache() clears every cached key', async () => {
    await fetchPropertyValuesOnce('project')
    await fetchPropertyValuesOnce('effort')
    expect(listPropertyValuesInvocationCount()).toBe(2)

    invalidatePropertyValuesCache()
    expect(getCachedPropertyValues('project')).toBe(PROPERTY_VALUES_EMPTY)
    expect(getCachedPropertyValues('effort')).toBe(PROPERTY_VALUES_EMPTY)
  })

  // ------------------------------------------------------------------
  // Subscriber notifications
  // ------------------------------------------------------------------
  it('notifies subscribers when an in-flight fetch resolves', async () => {
    const cb = vi.fn()
    const unsub = subscribeToPropertyValuesCache(cb)

    await fetchPropertyValuesOnce('project')
    expect(cb).toHaveBeenCalled()

    unsub()
    cb.mockClear()
    invalidatePropertyValuesCache()
    expect(cb).not.toHaveBeenCalled()
  })

  // ------------------------------------------------------------------
  // Error path falls back to empty array (matches pre-cache behaviour)
  // ------------------------------------------------------------------
  it('falls back to an empty array when listPropertyValues rejects', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('IPC failure'))
    const result = await fetchPropertyValuesOnce('project')
    expect(result).toEqual([])
    expect(listPropertyValuesInvocationCount()).toBe(1)

    // The cache remembers the empty fallback so a second consumer
    // doesn't re-trigger the failing IPC immediately.
    const second = await fetchPropertyValuesOnce('project')
    expect(second).toEqual([])
    expect(listPropertyValuesInvocationCount()).toBe(1)
  })
})
