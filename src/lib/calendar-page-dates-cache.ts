/**
 * The journal page-map cache behind `useCalendarPageDates` (#3626): settled
 * results per (space, range), an in-flight dedupe, and invalidation. It lives
 * in `src/lib` so the boot store can prefetch into it (#5438) without a store
 * importing a hook.
 */

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'

const inflightByKey = new Map<string, Promise<Map<string, string>>>()

/** A settled range fetch, retained so a re-subscribe reuses it (#3626). */
interface CachedPageMap {
  spaceId: string
  startDate: string
  endDate: string
  map: Map<string, string>
  /** `Date.now()` at the moment the fetch settled — drives {@link PAGE_DATES_TTL_MS}. */
  storedAt: number
  /**
   * #5438 — a subscriber already took this result as its own. The first
   * reader (the mount whose round trip it was, or the one the boot prefetch
   * was for) may act on it without re-asking the backend; a later mount
   * served from the cache may not, see {@link UseCalendarPageDatesResult.fetchedThisMount}.
   */
  claimed: boolean
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
 * page-delete flow, an import, a sync or an MCP write drops it). They cannot
 * cover a journal page that appears or disappears by some other route — a
 * page titled `2025-06-15` created from the page browser. Before this cache
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

const invalidationListeners = new Set<() => void>()

/**
 * Drop every cached range and re-fetch the ones on screen (#3626, #5258). Call
 * after a mutation that can add or remove a journal page — the shared
 * page-delete/restore flow, an applied sync or MCP write, an import. In-flight
 * fetches are abandoned rather than awaited: `cacheEpoch` makes their results
 * non-cacheable, so the invalidation cannot be overwritten by a response that
 * predates it.
 */
export function invalidateCalendarPageDates(): void {
  inflightByKey.clear()
  resultByKey.clear()
  cacheEpoch += 1
  for (const listener of invalidationListeners) listener()
}

export function subscribeToInvalidations(listener: () => void): () => void {
  invalidationListeners.add(listener)
  return () => {
    invalidationListeners.delete(listener)
  }
}

/**
 * Whether two page maps hold the same entries. A re-fetch that changed nothing
 * keeps the old map, so the memoised day sections built from it do not re-render.
 */
export function samePageMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [dateStr, pageId] of a) if (b.get(dateStr) !== pageId) return false
  return true
}

export function makeKey(spaceId: string, startDate: string, endDate: string): string {
  return `${spaceId}|${startDate}|${endDate}`
}

/** The settled, still-fresh entry for `key`; an expired one is dropped here. */
export function settledEntry(key: string): CachedPageMap | null {
  const settled = resultByKey.get(key)
  if (!settled) return null
  if (Date.now() - settled.storedAt < PAGE_DATES_TTL_MS) return settled
  resultByKey.delete(key)
  return null
}

/**
 * Mark the settled result for a range as taken by a subscriber. Returns
 * whether this was its first reader (#5438).
 */
export function claimSettled(spaceId: string, startDate: string, endDate: string): boolean {
  const entry = settledEntry(makeKey(spaceId, startDate, endDate))
  if (entry == null || entry.claimed) return false
  entry.claimed = true
  return true
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
export function mergeIntoCache(spaceId: string, dateStr: string, pageId: string): void {
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
 *
 * #5438 — the boot store calls this before any subscriber mounts, so the
 * fetch overlaps `list_spaces`; the first `useCalendarPageDates` for the same
 * range seeds from the settled result without a round trip.
 */
export function fetchPageMap(
  spaceId: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, string>> {
  const key = makeKey(spaceId, startDate, endDate)
  const settled = settledEntry(key)
  if (settled) return Promise.resolve(settled.map)
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
      resultByKey.set(key, {
        spaceId,
        startDate,
        endDate,
        map,
        storedAt: Date.now(),
        claimed: false,
      })
    }
  }, clear)
  return promise
}

/** The cache epoch, bumped on every invalidation (read by `useCalendarPageDatesEpoch`). */
export function getCalendarPageDatesEpoch(): number {
  return cacheEpoch
}
