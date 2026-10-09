/**
 * useCalendarPageDates — fetch the dateStr→pageId map of journal pages in
 * a bounded date range, dedup'd across multiple subscribers.
 *
 * The JournalPage component, JournalControls, and
 * GlobalDateControls each used to issue an identical
 * `listBlocks({blockType:'page',limit:500})` fetch on mount. When two of
 * them rendered together (JournalPage + JournalControls in the journal
 * view, or two separate calendar pickers in a future view), the same
 * query went out twice. This hook consolidates the fetch behind a
 * module-level in-flight promise so concurrent subscribers reuse a
 * single IPC round-trip, keyed by `(spaceId, startDate, endDate)`.
 *
 * Follow-up: the underlying fetch is now
 * `list_journal_pages_in_range`, scoped to the date range the caller
 * is actually rendering. Mirrors the per-month
 * `count_agenda_batch_by_source` fetch already used by
 * `JournalCalendarDropdown`. The previous "all journal pages in the
 * space" shape paid for off-screen results that no caller looked at.
 *
 * #3626: the dedupe is no longer in-flight-ONLY. `JournalCalendarDropdown`
 * is conditionally mounted (`{calendarOpen && <JournalCalendarDropdown …>}`)
 * so that closing it unmounts the subscriber — which is load-bearing for
 * month-state correctness (#3340) and must stay that way. With only an
 * in-flight map, every reopen was a fresh IPC round trip and a fresh blank →
 * repaint of the `hasContent` dots. The settled result is now retained per
 * range, merged on local page creation, dropped on page delete/restore, and
 * bounded by {@link PAGE_DATES_TTL_MS}.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import {
  claimSettled,
  fetchPageMap,
  getCalendarPageDatesEpoch,
  makeKey,
  mergeIntoCache,
  samePageMap,
  settledEntry,
  subscribeToInvalidations,
} from '@/lib/calendar-page-dates-cache'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useSpaceStore } from '@/stores/space'

export {
  __resetCalendarPageDatesForTests,
  invalidateCalendarPageDates,
  PAGE_DATES_TTL_MS,
  prefetchCalendarPageDates,
  samePageMap,
} from '@/lib/calendar-page-dates-cache'

/** Moves on every {@link invalidateCalendarPageDates}; a mounted page map re-fetches on it. */
export function useCalendarPageDatesEpoch(): number {
  return useSyncExternalStore(subscribeToInvalidations, getCalendarPageDatesEpoch)
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
  /**
   * #5438 — true when `pageMap` is the result of a round trip no earlier
   * subscriber took: this mount's own fetch, or the boot prefetch. A map
   * served from the cache a previous mount filled may predate a journal page
   * created by another route (see {@link PAGE_DATES_TTL_MS}), so a caller
   * that creates on absence re-probes unless this is true.
   */
  fetchedThisMount: boolean
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
  // #5438 — a range the boot prefetch (or an earlier mount) already settled
  // renders on the first frame instead of behind the loading skeleton.
  const [seed] = useState(() =>
    currentSpaceId == null ? null : settledEntry(makeKey(currentSpaceId, startDate, endDate)),
  )
  const [pageMap, setPageMap] = useState<Map<string, string>>(seed?.map ?? new Map())
  const [loading, setLoading] = useState(seed == null)
  const [fetchedThisMount, setFetchedThisMount] = useState(seed != null && !seed.claimed)
  // Track mount state so we don't setState after unmount.
  const mountedRef = useRef(true)
  const epoch = useCalendarPageDatesEpoch()
  // The range on screen. An invalidation re-fetches it in place: blanking it
  // would unmount the journal's day editors behind the loading skeleton.
  const shownRangeRef = useRef<string | null>(
    seed == null ? null : `${currentSpaceId}|${startDate}|${endDate}`,
  )

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    const start = performance.now()
    const rangeKey = `${currentSpaceId}|${startDate}|${endDate}`
    if (shownRangeRef.current !== rangeKey) {
      shownRangeRef.current = rangeKey
      setLoading(true)
      setPageMap(new Map())
    }
    // b1 — `listJournalPagesInRange` is required-active: with no active
    // space there are no journal pages to show, so short-circuit locally
    // to an empty page map instead of dispatching (a Global scope is
    // rejected by the backend).
    if (currentSpaceId == null) {
      // oxlint-disable-next-line react/set-state-in-effect -- settles the loading flag when no space is active, since `listJournalPagesInRange` is required-active and never runs; see #4407
      setLoading(false)
      return () => {
        cancelled = true
      }
    }
    fetchPageMap(currentSpaceId, startDate, endDate)
      .then((map) => {
        if (cancelled || !mountedRef.current) return
        setFetchedThisMount(claimSettled(currentSpaceId, startDate, endDate))
        setPageMap((prev) => (samePageMap(prev, map) ? prev : map))
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
        notify.error(t('journal.loadCalendarFailed'), { id: 'journal-load-calendar-failed' })
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [t, currentSpaceId, startDate, endDate, epoch])

  const addPage = useCallback(
    (dateStr: string, pageId: string) => {
      // #3626 — also merge into the module-level range cache, so a page this
      // app just created is reflected the next time the dropdown opens
      // instead of being masked by a cached pre-creation snapshot.
      if (currentSpaceId != null) mergeIntoCache(currentSpaceId, dateStr, pageId)
      setPageMap((prev) => {
        if (prev.get(dateStr) === pageId) return prev
        const next = new Map(prev)
        next.set(dateStr, pageId)
        return next
      })
    },
    [currentSpaceId],
  )

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

  return { pageMap, highlightedDays, loading, fetchedThisMount, addPage }
}
