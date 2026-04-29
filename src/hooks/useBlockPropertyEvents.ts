/**
 * useBlockPropertyEvents — listens for block:properties-changed Tauri events
 * and exposes an invalidation counter that panels can depend on for refetching.
 *
 * The backend emits "block:properties-changed" with { block_id, changed_keys }
 * whenever a property command succeeds (F-39 Phase 1). This hook debounces
 * rapid changes (150ms) and exposes a monotonic counter that triggers
 * useEffect re-runs in consumer components.
 */

import { useEffect, useRef, useState } from 'react'
import { logger } from '../lib/logger'
import { useTauriEventListener } from './useTauriEventListener'

/** Event payload matching Rust PropertyChangedEvent. */
interface PropertyChangedPayload {
  block_id: string
  changed_keys: string[]
}

const EVENT_NAME = 'block:properties-changed'
const DEBOUNCE_MS = 150

export interface UseBlockPropertyEventsReturn {
  /** Monotonic counter — increments on each (debounced) property change event. */
  invalidationKey: number
}

/**
 * MAINT-122: listener lifecycle (`listen()` → `unlisten()` + unmount
 * race) lives in `useTauriEventListener`; this hook owns the debounce
 * timer + the monotonic counter that consumers depend on for
 * refetching.
 */
export function useBlockPropertyEvents(): UseBlockPropertyEventsReturn {
  const [invalidationKey, setInvalidationKey] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useTauriEventListener<PropertyChangedPayload>(
    EVENT_NAME,
    () => {
      // Debounce: batch rapid consecutive changes
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        setInvalidationKey((prev) => prev + 1)
      }, DEBOUNCE_MS)
    },
    {
      onError: (err) => {
        logger.warn(
          'useBlockPropertyEvents',
          'Failed to listen for property change events',
          {},
          err,
        )
      },
    },
  )

  // Clean up the pending debounce timer on unmount so a late timer
  // can't fire `setInvalidationKey` after the component is gone.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return { invalidationKey }
}
