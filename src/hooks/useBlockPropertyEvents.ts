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

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import {
  DEBOUNCE_MS,
  ensureBlockPropertyEventsListener,
  getBlockPropertyInvalidationKey,
  subscribeToBlockPropertyEvents,
} from '@/lib/block-property-events'
import { logger } from '@/lib/logger'
import {
  ensurePropertyChangeDispatch,
  type PropertyChangeTarget,
  registerPropertyChangeTarget,
} from '@/lib/property-change-dispatch'

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

export interface UseScopedBlockPropertyEventsOptions {
  /**
   * Returns whether `blockId` belongs to this consumer's own scope (e.g. the
   * calling `BlockTree`'s page store). Called synchronously from inside the
   * fan-out target on every `block:properties-changed` event, so it should be
   * a cheap membership test (a Set/Map lookup) — NOT an O(n) scan. Read from a
   * ref internally, so passing a new function identity on every render does
   * not re-register the listener.
   */
  ownsBlock: (blockId: string) => boolean
}

/**
 * #2905 — per-consumer scoped variant of {@link useBlockPropertyEvents}.
 *
 * `useBlockPropertyEvents` exposes ONE module-global counter shared by every
 * consumer, so a `block:properties-changed` event for a single block bumps
 * every mounted consumer regardless of whether it owns that block. That is
 * correct (and load-bearing, #1818) for consumers that want a blanket "some
 * property somewhere changed" signal (GraphView's link cache, search, agenda,
 * ...). It is wasteful for `BlockTree`: journal week/month views mount 7+
 * trees at once, each backed by its own `BatchPropertiesProvider`, and the
 * global counter re-issues EVERY tree's `getBatchProperties` IPC for an edit
 * that may touch only one of them.
 *
 * This hook registers its OWN fan-out target (mirrors the pattern in
 * `property-keys-cache.ts` / `property-values-cache.ts`) and keeps a counter
 * local to the calling component instance. On each event:
 *   - a payload-less event (malformed, or a future bulk-change signal with no
 *     single `block_id`) is treated as a blanket "something changed" and
 *     always bumps — the safe fallback for anything that can't be attributed
 *     to a specific block;
 *   - otherwise the event only bumps this instance's counter if `ownsBlock`
 *     confirms the changed block belongs to this consumer.
 *
 * Debounced identically to the global counter (`DEBOUNCE_MS`) so rapid
 * consecutive edits to the SAME owned block still coalesce into one refetch.
 */
export function useScopedBlockPropertyEvents(
  options: UseScopedBlockPropertyEventsOptions,
): UseBlockPropertyEventsReturn {
  const ownsBlockRef = useRef(options.ownsBlock)
  ownsBlockRef.current = options.ownsBlock

  const [invalidationKey, setInvalidationKey] = useState(0)

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const target: PropertyChangeTarget = (payload) => {
      // No block_id to attribute the change to (malformed event, or a future
      // bulk-change signal) — never drop it, always invalidate (fallback).
      // Otherwise only bump when THIS consumer owns the changed block.
      const relevant = payload === undefined || ownsBlockRef.current(payload.block_id)
      if (!relevant) return

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        setInvalidationKey((prev) => prev + 1)
      }, DEBOUNCE_MS)
    }

    const unregister = registerPropertyChangeTarget(target)
    ensurePropertyChangeDispatch((err) => {
      logger.warn(
        'useScopedBlockPropertyEvents',
        'Failed to listen for property change events',
        {},
        err,
      )
    })

    return () => {
      unregister()
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  }, [])

  return { invalidationKey }
}
