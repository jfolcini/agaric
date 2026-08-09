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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useSpaceStore } from '@/stores/space'

const inflightByKey = new Map<string, Promise<Map<string, string>>>()

/** A settled range fetch, retained so a re-subscribe reuses it (#3626). */
interface CachedPageMap {
  spaceId: string
  startDate: string
  endDate: string
  map: Map<string, string>
  /** `Date.now()` at the moment the fetch settled — drives {@link PAGE_DATES_TTL_MS}. */
  storedAt: number
}

const resultByKey = new Map<string, CachedPageMap>()

/**
 * Bumped by every invalidation. A fetch that started under an older epoch
 * must not repopulate the cache when it lands, or an invalidation racing an
 * in-flight request would be undone by the stale response it was issued for.
 */
let cacheEpoch = 0

/**
 * #3626 — backstop lifetime for a cached range.
 *
 * The explicit invalidations below cover the mutations this app performs
 * itself (a journal page created through the journal's own add-block flow is
 * MERGED into the cache; a page deleted or restored through the shared
 * page-delete flow drops it). They cannot cover a journal page that appears
 * or disappears by some other route — a page titled `2025-06-15` created from
 * the page browser, an import, a sync from another device. Before this cache
 * every dropdown open was fresh, so an unbounded cache would turn a redundant
 * fetch into a permanently stale indicator; the TTL bounds that regression to
 * a minute while still collapsing the open → close → reopen burst the issue
 * is about.
 */
export const PAGE_DATES_TTL_MS = 60_000

/** Reset the module-level dedupe + result cache. Test-only. */
export function __resetCalendarPageDatesForTests(): void {
  inflightByKey.clear()
  resultByKey.clear()
  cacheEpoch += 1
}

/**
 * Drop every cached range so the next subscriber re-fetches (#3626). Call
 * after a mutation that can add or remove a journal page — the shared
 * page-delete/restore flow does. In-flight fetches are abandoned rather than
 * awaited: `cacheEpoch` makes their results non-cacheable, so the invalidation
 * cannot be overwritten by a response that predates it.
 */
export function invalidateCalendarPageDates(): void {
  inflightByKey.clear()
  resultByKey.clear()
  cacheEpoch += 1
}

function makeKey(spaceId: string, startDate: string, endDate: string): string {
  return `${spaceId}|${startDate}|${endDate}`
}

async function doFetch(
  spaceId: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, string>> {
  const rows = unwrap(
    await commands.listJournalPagesInRange(startDate, endDate, {
      kind: 'active',
      space_id: spaceId,
    }),
  )
  const map = new Map<string, string>()
  for (const b of rows) {
    if (b.content) map.set(b.content, b.id)
  }
  return map
}

/**
 * Merge a locally-created page into every cached range that covers its date
 * (#3626), so creating a journal page keeps the cache CORRECT instead of
 * having to throw it away. The entry is REPLACED with a fresh `Map` rather
 * than mutated: a subscriber may be holding the very same instance in React
 * state, and mutating it in place would change that state invisibly — the
 * `addPage` reducer's identity check would then see the entry already present
 * and skip the re-render that paints the new dot.
 *
 * `startDate`/`endDate` are ISO `YYYY-MM-DD`, so a lexicographic compare is
 * a chronological one.
 */
function mergeIntoCache(spaceId: string, dateStr: string, pageId: string): void {
  for (const [key, entry] of resultByKey) {
    if (entry.spaceId !== spaceId) continue
    if (dateStr < entry.startDate || dateStr > entry.endDate) continue
    if (entry.map.get(dateStr) === pageId) continue
    resultByKey.set(key, { ...entry, map: new Map(entry.map).set(dateStr, pageId) })
  }
}

/**
 * Run the IPC fetch once per range — across concurrent subscribers AND across
 * successive ones (#3626).
 *
 * The in-flight map alone only ever deduped CONCURRENT subscribers: its slot
 * was cleared the moment the fetch settled, so opening the calendar dropdown,
 * closing it (which UNMOUNTS it) and reopening cost two `list_journal_pages_in_range`
 * round trips, and the `hasContent` dots blanked and repainted on every open.
 * The settled result is now retained under the same key, bounded by
 * {@link PAGE_DATES_TTL_MS} and dropped by {@link invalidateCalendarPageDates}.
 */
function fetchPageMap(
  spaceId: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, string>> {
  const key = makeKey(spaceId, startDate, endDate)
  const settled = resultByKey.get(key)
  if (settled) {
    if (Date.now() - settled.storedAt < PAGE_DATES_TTL_MS) return Promise.resolve(settled.map)
    resultByKey.delete(key)
  }
  const cached = inflightByKey.get(key)
  if (cached) return cached
  const epoch = cacheEpoch
  const promise = doFetch(spaceId, startDate, endDate)
  inflightByKey.set(key, promise)
  // Clear the inflight slot once the fetch settles, and on the fulfilled
  // branch promote the result into the range cache. Observe both branches
  // with a single `.then(onF, onR)` so the rejection is consumed here as well
  // (otherwise this branch would leak as an "unhandled rejection" alongside
  // the legitimate consumer's `.catch` in the hook body). A REJECTED fetch is
  // deliberately not cached — the next open must retry, not memoise a failure.
  const clear = () => {
    if (inflightByKey.get(key) === promise) {
      inflightByKey.delete(key)
    }
  }
  promise.then((map) => {
    clear()
    if (cacheEpoch === epoch) {
      resultByKey.set(key, { spaceId, startDate, endDate, map, storedAt: Date.now() })
    }
  }, clear)
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
    // b1 — `listJournalPagesInRange` is required-active: with no active
    // space there are no journal pages to show, so short-circuit locally
    // to an empty page map instead of dispatching (a Global scope is
    // rejected by the backend).
    if (currentSpaceId == null) {
      setLoading(false)
      return () => {
        cancelled = true
      }
    }
    fetchPageMap(currentSpaceId, startDate, endDate)
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
  }, [t, currentSpaceId, startDate, endDate])

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

  return { pageMap, highlightedDays, loading, addPage }
}
