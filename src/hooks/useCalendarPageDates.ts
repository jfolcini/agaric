/**
 * useCalendarPageDates — fetch the dateStr→pageId map of journal pages once
 * per render-tree mount, dedup'd across multiple subscribers.
 *
 * MAINT-119: the JournalPage component, JournalControls, and
 * GlobalDateControls each used to issue an identical
 * `listBlocks({blockType:'page',limit:500})` fetch on mount. When two of
 * them rendered together (JournalPage + JournalControls in the journal
 * view, or two separate calendar pickers in a future view), the same
 * query went out twice. This hook consolidates the fetch behind a
 * module-level in-flight promise so concurrent subscribers reuse a
 * single IPC round-trip.
 *
 * The cache is intentionally only "in-flight" — once the promise
 * settles, `inflight` is cleared so the next fresh mount triggers a new
 * fetch. We do not try to share a long-lived cache here because the
 * page list mutates as the user creates daily journal pages; the
 * authoritative store of mutations lives in JournalPage's local state
 * (via `addPage`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { listBlocks } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'

// FEAT-3 Phase 4 — dedupe keyed by `spaceId` so two concurrent
// subscribers with different active spaces don't share a cached map.
const inflightBySpace = new Map<string, Promise<Map<string, string>>>()

/** Reset the module-level dedupe state. Test-only. */
export function __resetCalendarPageDatesForTests(): void {
  inflightBySpace.clear()
}

async function doFetch(spaceId: string): Promise<Map<string, string>> {
  // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`. Empty string is
  // the pre-bootstrap no-match fallback (passed in by `fetchPageMap`).
  const resp = await listBlocks({ blockType: 'page', limit: 500, spaceId })
  const map = new Map<string, string>()
  for (const b of resp.items) {
    if (b.content && /^\d{4}-\d{2}-\d{2}$/.test(b.content)) {
      map.set(b.content, b.id)
    }
  }
  return map
}

/** Run the IPC fetch once across all concurrent subscribers (per space). */
function fetchPageMap(spaceId: string): Promise<Map<string, string>> {
  const cached = inflightBySpace.get(spaceId)
  if (cached) return cached
  const promise = doFetch(spaceId)
  inflightBySpace.set(spaceId, promise)
  // Clear the inflight slot once the fetch settles. Observe both the
  // fulfilled and rejected branches with a single `.then(onF, onR)` so
  // the rejection is consumed here as well (otherwise this branch would
  // leak as an "unhandled rejection" alongside the legitimate consumer's
  // `.catch` in the hook body).
  const clear = () => {
    if (inflightBySpace.get(spaceId) === promise) {
      inflightBySpace.delete(spaceId)
    }
  }
  promise.then(clear, clear)
  return promise
}

export interface UseCalendarPageDatesResult {
  /** Map from `YYYY-MM-DD` to the page block ULID. */
  pageMap: Map<string, string>
  /** `Date` objects derived from `pageMap` keys, used by react-day-picker. */
  highlightedDays: Date[]
  /** True until the initial fetch settles. */
  loading: boolean
  /** Merge a locally-created page into the map without re-fetching. */
  addPage: (dateStr: string, pageId: string) => void
}

/**
 * React hook that returns the journal-page date set + page-id lookup,
 * sharing one in-flight fetch across all concurrent subscribers.
 */
export function useCalendarPageDates(): UseCalendarPageDatesResult {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [pageMap, setPageMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  // Track mount state so we don't setState after unmount.
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    const start = performance.now()
    // FEAT-3 Phase 4 — flip loading on each space change so callers
    // can re-show their skeleton; clear the stale map so the wrong
    // space's dates don't flash before the new fetch resolves.
    setLoading(true)
    setPageMap(new Map())
    // `listBlocks` requires `spaceId`. The `?? ''` fallback is
    // intentional pre-bootstrap behaviour: empty string forces a
    // no-match SQL filter rather than a runtime null deref.
    fetchPageMap(currentSpaceId ?? '')
      .then((map) => {
        if (cancelled || !mountedRef.current) return
        setPageMap(map)
        logger.debug('useCalendarPageDates', 'journal pages loaded', {
          pageCount: map.size,
          durationMs: Math.round(performance.now() - start),
        })
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) return
        logger.warn('useCalendarPageDates', 'page-dates fetch failed', undefined, err)
        toast.error(t('journal.loadCalendarFailed'))
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [t, currentSpaceId])

  const addPage = useCallback((dateStr: string, pageId: string) => {
    setPageMap((prev) => {
      if (prev.get(dateStr) === pageId) return prev
      const next = new Map(prev)
      next.set(dateStr, pageId)
      return next
    })
  }, [])

  const highlightedDays = useMemo(() => {
    const days: Date[] = []
    for (const dateStr of pageMap.keys()) {
      const parts = dateStr.split('-')
      if (parts.length === 3) {
        days.push(new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])))
      }
    }
    return days
  }, [pageMap])

  return { pageMap, highlightedDays, loading, addPage }
}
