/**
 * Tests for `src/lib/property-values-cache.ts` (#2596 — TanStack Query-backed).
 *
 * The hand-rolled Map/in-flight/subscriber cache is gone; the module is now a
 * thin wrapper over the shared `queryClient` singleton, keyed on the property
 * `key`. These tests pin the queryClient-backed contract while preserving
 * behavioural intent:
 *
 *  (a) cache hit — a second `fetchPropertyValuesOnce` for the same key fires
 *      only ONE `list_property_values` IPC,
 *  (b) in-flight dedupe — two concurrent calls share one IPC,
 *  (c) event invalidation — a `block:properties-changed` naming the cached key
 *      invalidates so the next fetch refetches,
 *  (d) per-changed-key eviction (#2507) — a change to one key evicts ONLY that
 *      key's entry, leaving other keys cached,
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
  _resetPropertyValuesCacheForTest,
  EVENT_PROPERTY_CHANGED,
  ensurePropertyValuesInvalidationListener,
  fetchPropertyValuesOnce,
  invalidatePropertyValuesCache,
  propertyValuesQueryKey,
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

function fireInvalidationEvent(changedKeys: string[] = ['project']): void {
  const handler = eventListeners.get(EVENT_PROPERTY_CHANGED)
  if (!handler) throw new Error(`${EVENT_PROPERTY_CHANGED} listener was never registered`)
  handler({ payload: { block_id: 'BLK01', changed_keys: changedKeys } })
}

describe('property-values-cache', () => {
  // ------------------------------------------------------------------
  // (a) Cache hit — a second fetch reuses the cached array, no new IPC
  // ------------------------------------------------------------------
  it('caches the result so a second fetch reuses the cached array without firing IPC', async () => {
    const first = await fetchPropertyValuesOnce('project')
    expect(first).toEqual(['alpha', 'beta'])
    expect(listPropertyValuesInvocationCount()).toBe(1)

    const second = await fetchPropertyValuesOnce('project')
    expect(second).toBe(first) // same array reference — cached
    expect(listPropertyValuesInvocationCount()).toBe(1)
    expect(queryClient.getQueryData(propertyValuesQueryKey('project'))).toEqual(['alpha', 'beta'])
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
  // (c) An event naming the cached key invalidates so the next fetch refetches
  // ------------------------------------------------------------------
  it('block:properties-changed invalidates the changed key so the next fetch refetches', async () => {
    ensurePropertyValuesInvalidationListener()
    await fetchPropertyValuesOnce('project')
    expect(listPropertyValuesInvocationCount()).toBe(1)

    // Materializer signals that `project` values changed.
    fireInvalidationEvent(['project'])

    expect(queryClient.getQueryState(propertyValuesQueryKey('project'))?.isInvalidated).toBe(true)

    // Next fetch fires a fresh IPC.
    mockedInvoke.mockResolvedValueOnce(['alpha', 'beta', 'gamma'])
    const refreshed = await fetchPropertyValuesOnce('project')
    expect(refreshed).toEqual(['alpha', 'beta', 'gamma'])
    expect(listPropertyValuesInvocationCount()).toBe(2)
  })

  // ------------------------------------------------------------------
  // (d) #2507 keyed eviction: an event invalidates ONLY the entries for its
  //     `changed_keys`; unrelated keys keep their cached array and fire no
  //     refetch.
  // ------------------------------------------------------------------
  it('evicts only the changed keys and leaves unrelated keys cached (#2507)', async () => {
    ensurePropertyValuesInvalidationListener()
    const project = await fetchPropertyValuesOnce('project')
    const effort = await fetchPropertyValuesOnce('effort')
    expect(listPropertyValuesInvocationCount()).toBe(2)

    // Only `project` changed.
    fireInvalidationEvent(['project'])

    // `project` is invalidated; `effort` is untouched (still valid, same array).
    expect(queryClient.getQueryState(propertyValuesQueryKey('project'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(propertyValuesQueryKey('effort'))?.isInvalidated).toBe(false)

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

  it('invalidatePropertyValuesCache() invalidates every cached key so they refetch', async () => {
    await fetchPropertyValuesOnce('project')
    await fetchPropertyValuesOnce('effort')
    expect(listPropertyValuesInvocationCount()).toBe(2)

    invalidatePropertyValuesCache()
    expect(queryClient.getQueryState(propertyValuesQueryKey('project'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(propertyValuesQueryKey('effort'))?.isInvalidated).toBe(true)

    await fetchPropertyValuesOnce('project')
    await fetchPropertyValuesOnce('effort')
    expect(listPropertyValuesInvocationCount()).toBe(4)
  })

  // ------------------------------------------------------------------
  // (e) Error path falls back to empty array, and the fallback is cached.
  // ------------------------------------------------------------------
  it('falls back to an empty array when listPropertyValues rejects and caches it', async () => {
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
