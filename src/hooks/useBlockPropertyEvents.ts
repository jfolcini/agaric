/**
 * useBlockPropertyEvents — listens for block:properties-changed Tauri events
 * and exposes an invalidation counter that panels can depend on for refetching.
 *
 * The backend emits "block:properties-changed" with { block_id, changed_keys }
 * whenever a property command succeeds (F-39 Phase 1). This hook debounces
 * rapid changes (150ms) and exposes a monotonic counter that triggers
 * useEffect re-runs in consumer components.
 */

import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { logger } from '../lib/logger'

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

export function useBlockPropertyEvents(): UseBlockPropertyEventsReturn {
  const [invalidationKey, setInvalidationKey] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    // `@tauri-apps/api/event` is statically imported by useSyncEvents /
    // ConflictList so it's already in the entry chunk — using a static
    // import here too avoids Rolldown's INEFFECTIVE_DYNAMIC_IMPORT warning
    // without changing behaviour.
    const unlistenPromise = listen<PropertyChangedPayload>(EVENT_NAME, (_event) => {
      if (cancelled) return
      // Debounce: batch rapid consecutive changes
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        if (!cancelled) {
          setInvalidationKey((prev) => prev + 1)
        }
      }, DEBOUNCE_MS)
    }).catch((err: unknown) => {
      logger.warn('useBlockPropertyEvents', 'Failed to listen for property change events', {}, err)
      return undefined
    })

    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
      unlistenPromise.then((unlisten) => {
        if (unlisten) unlisten()
      })
    }
  }, [])

  return { invalidationKey }
}
