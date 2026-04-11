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

    async function setup() {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const unlisten = await listen<PropertyChangedPayload>(EVENT_NAME, (_event) => {
          if (cancelled) return
          // Debounce: batch rapid consecutive changes
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => {
            if (!cancelled) {
              setInvalidationKey((prev) => prev + 1)
            }
          }, DEBOUNCE_MS)
        })

        return () => {
          cancelled = true
          if (timerRef.current) clearTimeout(timerRef.current)
          unlisten()
        }
      } catch {
        logger.warn('useBlockPropertyEvents', 'Failed to listen for property change events')
        return undefined
      }
    }

    let cleanup: (() => void) | undefined
    setup().then((fn) => {
      cleanup = fn
    })

    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
      cleanup?.()
    }
  }, [])

  return { invalidationKey }
}
