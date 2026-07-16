/**
 * property-change-dispatch — the single, module-level subscriber for the
 * `block:properties-changed` Tauri event.
 *
 * #2507: the backend ships a targeted payload on every property write —
 * `PropertyChangedEvent { block_id, changed_keys }`
 * (`emit_property_changed_event`, `src-tauri/src/commands/properties.rs`) — but
 * the frontend used to register THREE independent `listen()` subscriptions of
 * that one event, each throwing the payload away and doing blanket work:
 *
 *   1. `block-property-events.ts`   — debounced global invalidation counter
 *   2. `property-keys-cache.ts`     — clears the whole property-KEY cache
 *   3. `property-values-cache.ts`   — clears the whole property-VALUE cache
 *
 * Three `listen()` registrations of the same event, each waking on every change
 * anywhere. This module collapses them to ONE registration: consumers register
 * a {@link PropertyChangeTarget} and the single listener fans the payload out to
 * every target. Each target then decides — from the payload — how much to
 * invalidate (blanket counter bump, per-`changed_keys` value eviction, or a
 * skip-when-no-new-key check for the key cache). The net effect is fewer
 * listener registrations AND fewer needless refetches on unrelated edits.
 *
 * The subscription stays MODULE-LEVEL and process-lifetime, never per-component
 * (the #1818 lesson): a mutation that fires while a consumer is unmounted must
 * still be observed so the next mount reads fresh state.
 */

import { listen } from '@tauri-apps/api/event'

import { EVENT_PROPERTY_CHANGED } from '@/lib/block-event-names'
import { logger } from '@/lib/logger'

export { EVENT_PROPERTY_CHANGED }

/** Event payload matching Rust `PropertyChangedEvent`. */
export interface PropertyChangedPayload {
  block_id: string
  changed_keys: string[]
}

/**
 * A registered fan-out target. Invoked once per `block:properties-changed`
 * event with the event payload (or `undefined` if a malformed/payload-less
 * event arrives — targets should treat that as a blanket "something changed").
 */
export type PropertyChangeTarget = (payload: PropertyChangedPayload | undefined) => void

const targets = new Set<PropertyChangeTarget>()
let listenerInitialized = false

/**
 * Register a fan-out target for `block:properties-changed`. Returns an
 * unregister fn. Registration is synchronous and independent of the underlying
 * Tauri `listen()` — call {@link ensurePropertyChangeDispatch} to make sure the
 * one process-lifetime listener is actually wired up.
 */
export function registerPropertyChangeTarget(target: PropertyChangeTarget): () => void {
  targets.add(target)
  return () => {
    targets.delete(target)
  }
}

/** Fan a payload out to every registered target. */
function dispatch(payload: PropertyChangedPayload | undefined): void {
  for (const target of targets) {
    target(payload)
  }
}

/**
 * Lazily register the ONE process-lifetime Tauri listener that fans
 * `block:properties-changed` out to every registered target. Idempotent — safe
 * to call from every consumer on every render; only the first successful call
 * subscribes. Mirrors the Tauri-only gate used elsewhere so jsdom / browser-mode
 * dev sessions don't trigger a `transformCallback` NPE from the unmocked
 * `@tauri-apps/api/event` import.
 *
 * @param onError optional handler invoked if `listen()` rejects. On failure the
 *   init flag is reset so a later consumer's call retries the subscription.
 */
export function ensurePropertyChangeDispatch(onError?: (err: unknown) => void): void {
  if (listenerInitialized) return
  listenerInitialized = true
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!inTauri) return
  listen<PropertyChangedPayload>(EVENT_PROPERTY_CHANGED, (event) => {
    dispatch(event.payload)
  }).catch((err: unknown) => {
    // Allow a retry on a later call if the initial subscription failed.
    listenerInitialized = false
    if (onError) {
      onError(err)
    } else {
      logger.warn(
        'property-change-dispatch',
        'failed to register property-change listener',
        undefined,
        err,
      )
    }
  })
}

/**
 * Test-only reset. Drops every registered target and clears the lazy-listener
 * flag so each test starts from a clean slate. Imported by the consumer
 * `_reset*ForTest` helpers so a single consumer reset returns the whole
 * dispatch chain to a pristine state.
 */
export function _resetPropertyChangeDispatchForTest(): void {
  targets.clear()
  listenerInitialized = false
}
