/**
 * useStreamDates — windowed date list + page map for the continuous
 * infinite-scroll journal stream (#1415, Logseq-style).
 *
 * The stream renders a single chronological column of daily date pages,
 * today anchored at the top, older days appended below as the user scrolls
 * toward the bottom. Unlike the daily/weekly/monthly surfaces — which fetch
 * a single fixed range via `useCalendarPageDates` — the stream's visible
 * window GROWS over a session: each `loadOlder()` call extends the oldest
 * loaded date further into the past (and refetches the page map for the
 * newly-revealed span).
 *
 * Design notes:
 *  - Dates descend from `today` (index 0) to `oldest` (last). Rendering
 *    today first keeps it pinned at the top with no scroll-anchoring math.
 *  - `pageMap` (`dateStr → pageId`) is fetched once per window growth. We
 *    fetch the FULL current window each time rather than diffing batches:
 *    `list_journal_pages_in_range` is bounded + cheap, the dedupe cache in
 *    `useCalendarPageDates` is range-keyed (different range each grow, so
 *    it wouldn't help here), and a single full-window map sidesteps merge
 *    bugs when a page is created mid-window.
 *  - `MIN_JOURNAL_DATE` caps how far back the stream can load, matching the
 *    navigable horizon of the other journal surfaces.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

import { formatDate, MIN_JOURNAL_DATE } from '../lib/date-utils'
import { listJournalPagesInRange } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'

/** Number of days revealed per `loadOlder()` call (one "batch"). */
export const STREAM_BATCH_DAYS = 14

/** Number of days shown on first mount (today + the preceding span). */
export const STREAM_INITIAL_DAYS = 14

/** Subtract `n` whole days from a date (local time, DST-safe via setDate). */
function subtractDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() - n)
  next.setHours(0, 0, 0, 0)
  return next
}

export interface UseStreamDatesResult {
  /** Descending list of dates: today first, oldest last. */
  dates: Date[]
  /** Map from `YYYY-MM-DD` to the page block ULID for loaded days. */
  pageMap: Map<string, string>
  /** True until the initial page-map fetch settles. */
  loading: boolean
  /** True while an older batch's page map is being fetched. */
  loadingOlder: boolean
  /** True once the oldest loaded day reaches `MIN_JOURNAL_DATE`. */
  reachedEnd: boolean
  /** Reveal another `STREAM_BATCH_DAYS` of older days. */
  loadOlder: () => void
  /** Merge a locally-created page into the map without re-fetching. */
  addPage: (dateStr: string, pageId: string) => void
}

/**
 * React hook backing the continuous journal stream. Owns the windowed
 * date list (today → oldest), the page-id lookup for that window, and the
 * `loadOlder` extension that drives infinite scroll.
 */
export function useStreamDates(): UseStreamDatesResult {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)

  // Anchor `today` once per mount so the column doesn't reshuffle if the
  // wall clock ticks past midnight mid-session (the daily surfaces have a
  // dedicated `useToday` for that; the stream re-anchors on remount).
  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  // `oldestOffset` = how many days before today the window currently
  // extends. Grows by STREAM_BATCH_DAYS per `loadOlder`, clamped so the
  // oldest day never precedes MIN_JOURNAL_DATE.
  const maxOffset = useMemo(() => {
    const ms = today.getTime() - MIN_JOURNAL_DATE.getTime()
    return Math.max(0, Math.floor(ms / 86_400_000))
  }, [today])

  const [oldestOffset, setOldestOffset] = useState(() =>
    Math.min(STREAM_INITIAL_DAYS - 1, maxOffset),
  )

  const dates = useMemo(() => {
    const out: Date[] = []
    for (let i = 0; i <= oldestOffset; i++) out.push(subtractDays(today, i))
    return out
  }, [today, oldestOffset])

  const reachedEnd = oldestOffset >= maxOffset

  const loadOlder = useCallback(() => {
    setOldestOffset((prev) => Math.min(prev + STREAM_BATCH_DAYS, maxOffset))
  }, [maxOffset])

  const [pageMap, setPageMap] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const mountedRef = useRef(true)
  // Distinguish the first fetch (full-screen skeleton) from a grow fetch
  // (older-batch spinner) without re-running the effect on the flag.
  const firstFetchRef = useRef(true)

  const startDate = formatDate(subtractDays(today, oldestOffset))
  const endDate = formatDate(today)

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    const isFirst = firstFetchRef.current
    if (isFirst) setLoading(true)
    else setLoadingOlder(true)

    listJournalPagesInRange({ startDate, endDate, spaceId: currentSpaceId ?? '' })
      .then((rows) => {
        if (cancelled || !mountedRef.current) return
        const map = new Map<string, string>()
        for (const b of rows) {
          if (b.content) map.set(b.content, b.id)
        }
        setPageMap(map)
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) return
        logger.warn('useStreamDates', 'stream page-dates fetch failed', undefined, err)
        notify.error(t('journal.loadCalendarFailed'), { id: 'journal-load-calendar-failed' })
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return
        setLoading(false)
        setLoadingOlder(false)
        firstFetchRef.current = false
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

  return { dates, pageMap, loading, loadingOlder, reachedEnd, loadOlder, addPage }
}
