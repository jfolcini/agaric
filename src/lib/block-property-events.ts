/**
 * block-property-events — module-level invalidation counter for the
 * `block:properties-changed` Tauri event.
 *
 * #1818: this state used to live inside `useBlockPropertyEvents` as a
 * per-component `useState(0)` counter. That reset to 0 on every mount, while
 * module-level consumer caches (notably `graphCacheMap` in `GraphView`) persist
 * across mount/unmount. The mismatch meant a page or `[[link]]` mutation that
 * fired while a consumer was UNMOUNTED was never observed, so a remount within
 * the cache TTL served the stale cached entry without refetching.
 *
 * Hoisting the counter and its Tauri listener to module scope fixes that: the
 * counter increments on every (debounced) mutation event regardless of mount
 * state, so the next mount within the TTL reads a higher key and refetches.
 *
 * Mirrors the lazy-listener / subscriber-set / `useSyncExternalStore` shape of
 * `src/lib/property-keys-cache.ts`. The React adapter lives in
 * `src/hooks/useBlockPropertyEvents.ts`.
 */

import { listen } from '@tauri-apps/api/event'

import { logger } from './logger'

/** Tauri event name — mirrors `EVENT_PROPERTY_CHANGED` in
 *  `src-tauri/src/sync_events.rs`. */
export const EVENT_PROPERTY_CHANGED = 'block:properties-changed'

/** Debounce window: batch rapid consecutive property changes (matches the
 *  pre-#1818 per-component behavior). */
export const DEBOUNCE_MS = 150

/** Event payload matching Rust `PropertyChangedEvent`. */
export interface PropertyChangedPayload {
  block_id: string
  changed_keys: string[]
}

let invalidationKey = 0
const subscribers = new Set<() => void>()
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let listenerInitialized = false

function notify(): void {
  for (const cb of subscribers) cb()
}

/**
 * Synchronous snapshot of the current invalidation counter. This is the
 * snapshot fn used by `useSyncExternalStore`; it returns a primitive so
 * referential stability is automatic.
 */
export function getBlockPropertyInvalidationKey(): number {
  return invalidationKey
}

/**
 * Subscribe to invalidation-counter changes. Returns an unsubscribe fn. Used by
 * the React adapter via `useSyncExternalStore`.
 */
export function subscribeToBlockPropertyEvents(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Record a property-change event. Debounces rapid consecutive changes
 * (`DEBOUNCE_MS`) and increments the module-level counter once the window
 * settles, notifying subscribers. Exposed for the Tauri listener and for tests
 * that drive the counter directly.
 */
export function recordBlockPropertyChange(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    invalidationKey += 1
    notify()
  }, DEBOUNCE_MS)
}

/**
 * Lazily register the process-lifetime Tauri listener. Idempotent — once
 * registered it stays for the rest of the session (the counter is meant to
 * survive any individual component's mount/unmount, which is the whole point of
 * #1818). Mirrors the Tauri-only gate from `property-keys-cache.ts` so jsdom /
 * browser-mode dev sessions don't trigger a `transformCallback` NPE from the
 * unmocked `@tauri-apps/api/event` import.
 *
 * @param onError optional handler invoked if `listen()` rejects, so the React
 *   adapter can preserve its existing `logger.warn` shape.
 */
export function ensureBlockPropertyEventsListener(onError?: (err: unknown) => void): void {
  if (listenerInitialized) return
  listenerInitialized = true
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!inTauri) return
  listen<PropertyChangedPayload>(EVENT_PROPERTY_CHANGED, () => {
    recordBlockPropertyChange()
  }).catch((err: unknown) => {
    // Allow a retry on a later mount if the initial subscription failed.
    listenerInitialized = false
    if (onError) {
      onError(err)
    } else {
      logger.warn(
        'block-property-events',
        'failed to register property-change listener',
        undefined,
        err,
      )
    }
  })
}

/**
 * Test-only reset. Clears the counter, any pending debounce timer, the
 * subscriber set, and the lazy-listener flag so each test starts from a clean
 * slate. Imported directly by tests; not part of the public surface.
 */
export function _resetBlockPropertyEventsForTest(): void {
  invalidationKey = 0
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  subscribers.clear()
  listenerInitialized = false
}
