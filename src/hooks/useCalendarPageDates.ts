/**
 * useCalendarPageDates — fetch the dateStr→pageId map of journal pages in
 * a bounded date range, dedup'd across multiple subscribers.
 *
 * MAINT-119: the JournalPage component, JournalControls, and
 * GlobalDateControls each used to issue an identical
 * `listBlocks({blockType:'page',limit:500})` fetch on mount. When two of
 * them rendered together (JournalPage + JournalControls in the journal
 * view, or two separate calendar pickers in a future view), the same
 * query went out twice. This hook consolidates the fetch behind a
 * module-level in-flight promise so concurrent subscribers reuse a
 * single IPC round-trip, keyed by `(spaceId, startDate, endDate)`.
 *
 * BUG-48 follow-up: the underlying fetch is now
 * `list_journal_pages_in_range`, scoped to the date range the caller
 * is actually rendering. Mirrors the per-month
 * `count_agenda_batch_by_source` fetch already used by
 * `JournalCalendarDropdown`. The previous "all journal pages in the
 * space" shape paid for off-screen results that no caller looked at.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { listJournalPagesInRange } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'

const inflightByKey = new Map<string, Promise<Map<string, string>>>()

/** Reset the module-level dedupe state. Test-only. */
export function __resetCalendarPageDatesForTests(): void {
  inflightByKey.clear()
}

function makeKey(spaceId: string, startDate: string, endDate: string): string {
  return `${spaceId}|${startDate}|${endDate}`
}

async function doFetch(
  spaceId: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, string>> {
  const rows = await listJournalPagesInRange({ startDate, endDate, spaceId })
  const map = new Map<string, string>()
  for (const b of rows) {
    if (b.content) map.set(b.content, b.id)
  }
  return map
}

/** Run the IPC fetch once across all concurrent subscribers (per range). */
function fetchPageMap(
  spaceId: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, string>> {
  const key = makeKey(spaceId, startDate, endDate)
  const cached = inflightByKey.get(key)
  if (cached) return cached
  const promise = doFetch(spaceId, startDate, endDate)
  inflightByKey.set(key, promise)
  // Clear the inflight slot once the fetch settles. Observe both the
  // fulfilled and rejected branches with a single `.then(onF, onR)` so
  // the rejection is consumed here as well (otherwise this branch would
  // leak as an "unhandled rejection" alongside the legitimate consumer's
  // `.catch` in the hook body).
  const clear = () => {
    if (inflightByKey.get(key) === promise) {
      inflightByKey.delete(key)
    }
  }
  promise.then(clear, clear)
  return promise
}

export interface UseCalendarPageDatesOptions {
  /** Inclusive start of the visible date range (`YYYY-MM-DD`). */
  startDate: string
  /** Inclusive end of the visible date range (`YYYY-MM-DD`). */
  endDate: string
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
 * React hook that returns the journal-page date set + page-id lookup for the
 * provided `[startDate, endDate]` range, sharing one in-flight fetch across
 * all concurrent subscribers with the same range key.
 */
export function useCalendarPageDates(
  opts: UseCalendarPageDatesOptions,
): UseCalendarPageDatesResult {
  const { startDate, endDate } = opts
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
    setLoading(true)
    setPageMap(new Map())
    // `listJournalPagesInRange` requires `spaceId`. The `?? ''` fallback
    // is intentional pre-bootstrap behaviour: empty string forces a
    // no-match SQL filter rather than a runtime null deref.
    fetchPageMap(currentSpaceId ?? '', startDate, endDate)
      .then((map) => {
        if (cancelled || !mountedRef.current) return
        setPageMap(map)
        logger.debug('useCalendarPageDates', 'journal pages loaded', {
          pageCount: map.size,
          startDate,
          endDate,
          durationMs: Math.round(performance.now() - start),
        })
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) return
        logger.warn('useCalendarPageDates', 'page-dates fetch failed', undefined, err)
        notify.error(t('journal.loadCalendarFailed'))
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [t, currentSpaceId, startDate, endDate])

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
