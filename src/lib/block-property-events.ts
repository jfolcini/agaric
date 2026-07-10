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
 * Hoisting the counter and its listener registration to module scope fixes
 * that: the counter increments on every (debounced) mutation event regardless
 * of mount state, so the next mount within the TTL reads a higher key and
 * refetches.
 *
 * #2507: the counter no longer registers its own `listen()`. It is one of three
 * consumers that used to each subscribe to `block:properties-changed`
 * independently; all three now register a fan-out TARGET on the single
 * module-level dispatcher in `property-change-dispatch.ts`. The counter's target
 * stays deliberately blanket (a cheap payload-agnostic bump).
 *
 * The React adapter lives in `src/hooks/useBlockPropertyEvents.ts`.
 */

import { EVENT_PROPERTY_CHANGED } from './block-event-names'
import {
  _resetPropertyChangeDispatchForTest,
  ensurePropertyChangeDispatch,
  type PropertyChangedPayload,
  registerPropertyChangeTarget,
} from './property-change-dispatch'

export { EVENT_PROPERTY_CHANGED }
export type { PropertyChangedPayload }

/** Debounce window: batch rapid consecutive property changes (matches the
 *  pre-#1818 per-component behavior). */
export const DEBOUNCE_MS = 150

let invalidationKey = 0
const subscribers = new Set<() => void>()
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let targetRegistered = false
let unregisterTarget: (() => void) | null = null

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
 * Register the blanket counter's fan-out target on the shared
 * `block:properties-changed` dispatcher and make sure the dispatcher's single
 * process-lifetime listener is wired up (#2507). Idempotent — the target is
 * added once, and `ensurePropertyChangeDispatch` self-guards (and retries on a
 * prior `listen()` failure). The counter ignores the payload (it is deliberately
 * a blanket bump — cheap, and every consumer that reads it wants "something
 * changed"), so the target discards its argument.
 *
 * The registration is MODULE-LEVEL and survives any individual component's
 * mount/unmount — the whole point of #1818: a mutation that fires while a
 * consumer is unmounted must still bump the counter so the next mount refetches.
 *
 * @param onError optional handler invoked if the dispatcher's `listen()`
 *   rejects, so the React adapter can preserve its existing `logger.warn` shape.
 */
export function ensureBlockPropertyEventsListener(onError?: (err: unknown) => void): void {
  if (!targetRegistered) {
    targetRegistered = true
    unregisterTarget = registerPropertyChangeTarget(() => {
      recordBlockPropertyChange()
    })
  }
  ensurePropertyChangeDispatch(onError)
}

/**
 * Test-only reset. Clears the counter, any pending debounce timer, the
 * subscriber set, the fan-out target registration, and the shared dispatcher so
 * each test starts from a clean slate. Imported directly by tests; not part of
 * the public surface.
 */
export function _resetBlockPropertyEventsForTest(): void {
  invalidationKey = 0
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  subscribers.clear()
  targetRegistered = false
  if (unregisterTarget) {
    unregisterTarget()
    unregisterTarget = null
  }
  _resetPropertyChangeDispatchForTest()
}
