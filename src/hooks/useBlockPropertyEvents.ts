/**
 * useBlockPropertyEvents — listens for block:properties-changed Tauri events
 * and exposes an invalidation counter that panels can depend on for refetching.
 *
 * The backend emits "block:properties-changed" with { block_id, changed_keys }
 * whenever a property command succeeds (F-39 Phase 1). This hook debounces
 * rapid changes (150ms) and exposes a monotonic counter that triggers
 * useEffect re-runs in consumer components.
 *
 * #1818: the invalidation counter and its Tauri listener now live at MODULE
 * scope (`src/lib/block-property-events.ts`, the same pattern as
 * `src/lib/property-keys-cache.ts`). The previous implementation kept the
 * counter in a per-component `useState(0)`, which RESET to 0 on every mount
 * while module-level consumer caches (e.g. `graphCacheMap` in `GraphView`)
 * persisted across mount/unmount. A page or `[[link]]` created while a consumer
 * (GraphView) was UNMOUNTED was therefore never observed, so a remount within
 * the cache TTL served stale data. By keeping the counter alive across unmount,
 * a mutation that fires while a consumer is unmounted still increments it — so
 * the next mount reads a higher key and refetches.
 */

import { useSyncExternalStore } from 'react'

import {
  ensureBlockPropertyEventsListener,
  getBlockPropertyInvalidationKey,
  subscribeToBlockPropertyEvents,
} from '../lib/block-property-events'
import { logger } from '../lib/logger'

export interface UseBlockPropertyEventsReturn {
  /** Monotonic counter — increments on each (debounced) property change event. */
  invalidationKey: number
}

/**
 * Subscribe to the module-level block-property invalidation counter.
 *
 * The counter increments (debounced) on every `block:properties-changed`
 * Tauri event regardless of whether any component is mounted. Consumers read
 * it as a dependency to trigger refetches. Because the counter is module-level
 * it survives unmount/remount, so a mutation that occurs while a consumer is
 * unmounted is still reflected on the next mount (#1818).
 */
export function useBlockPropertyEvents(): UseBlockPropertyEventsReturn {
  // Lazily register the process-lifetime Tauri listener. Idempotent — safe to
  // call on every render; only the first call actually subscribes. Gated on
  // Tauri presence inside the helper so jsdom/browser-mode dev sessions don't
  // hit an unmocked `listen()`.
  ensureBlockPropertyEventsListener((err) => {
    logger.warn('useBlockPropertyEvents', 'Failed to listen for property change events', {}, err)
  })

  const invalidationKey = useSyncExternalStore(
    subscribeToBlockPropertyEvents,
    getBlockPropertyInvalidationKey,
  )

  return { invalidationKey }
}
