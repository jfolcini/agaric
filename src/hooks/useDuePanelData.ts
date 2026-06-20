/**
 * useDuePanelData — data fetching hook for DuePanel.
 *
 * Encapsulates the 3 data fetches (blocks, overdue, upcoming, projected)
 * and their state management. Returns fetched data, loading states,
 * page titles, and a loadMore function.
 *
 * Extracted from DuePanel.tsx for testability (#651-R6).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatDate } from '@/lib/date-utils'
import { notify } from '@/lib/notify'

import { logger } from '../lib/logger'
import type { BlockRow, PageResponse, ProjectedAgendaEntry, ResolvedBlock } from '../lib/tauri'
import {
  batchResolve,
  listBlocks,
  listBlocksLimit,
  listProjectedAgenda,
  listProjectedAgendaLimit,
  paginationLimit,
  queryByProperty,
} from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { useBlockPropertyEvents } from './useBlockPropertyEvents'
import { useToday } from './useToday'

// ── ULID reference extraction (B-53) ──────────────────────────────────
/** Matches [[ULID]], #[ULID], and ((ULID)) refs inside block content. */
const ULID_REF_RE = /(?:\[\[|#\[|\(\()([0-9A-Z]{26})(?:\]\]|\]|\)\))/g

/** Extract all ULID references from a string. */
export function extractUlidRefs(text: string): string[] {
  const ids: string[] = []
  let m: RegExpExecArray | null
  while ((m = ULID_REF_RE.exec(text)) !== null) {
    const id = m[1] as string
    ids.push(id)
  }
  return ids
}

// ── Module-level cache for projected agenda ──────────────────
const PROJECTED_CACHE_TTL_MS = 30_000 // 30 seconds

interface ProjectedCacheEntry {
  entries: ProjectedAgendaEntry[]
  timestamp: number
}

const projectedCache = new Map<string, ProjectedCacheEntry>()

/** @internal — exported for test isolation only. */
export function clearProjectedCache(): void {
  projectedCache.clear()
}

// ── Pure helpers ───────────────────────────────────────────
// Factored out of doFetch/fetchBlocks to keep oxlint eslint/complexity
// bounded. Each helper is side-effect-free and independently testable.

/**
 * Apply the `property:` source filter (excludes blocks whose due_date or
 * scheduled_date matches the current agenda date) and drop blocks with
 * Empty or whitespace-only content. Other sourceFilter values
 * pass through unchanged except for the empty-content pass.
 */
export function applySourceFilter(
  items: BlockRow[],
  date: string,
  sourceFilter: string | null,
): BlockRow[] {
  const afterSource =
    sourceFilter === 'property:'
      ? items.filter((b) => b.due_date !== date && b.scheduled_date !== date)
      : items
  return afterSource.filter((b) => b.content?.trim())
}

/**
 * Build a deduped list of block IDs to feed `batchResolve`: every
 * non-null `page_id` plus every inline ULID reference found in content.
 */
export function collectResolveIds(blocks: BlockRow[]): string[] {
  const pageIds = blocks.map((b) => b.page_id).filter((id): id is string => id != null)
  const contentRefs = blocks.flatMap((b) => (b.content ? extractUlidRefs(b.content) : []))
  return [...new Set([...pageIds, ...contentRefs])]
}

/**
 * Convert the resolver response into a title map, substituting the
 * fallback string whenever the backend returns a null/undefined title.
 */
export function buildTitleMap(resolved: ResolvedBlock[], fallback: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const r of resolved) {
    map.set(r.id, r.title ?? fallback)
  }
  return map
}

/**
 * Thin wrapper around `listBlocks` that encodes the agenda-specific
 * calling convention: `property:` collapses to a null source, and the
 * optional `cursor` arg is only included when defined.
 *
 * Phase 4 — `listBlocks` requires `spaceId`. Callers thread
 * `currentSpaceId` (or `''` pre-bootstrap) so agenda views are space-scoped.
 */
function listBlocksForAgenda(
  date: string,
  sourceFilter: string | null,
  cursor: string | undefined,
  limit: number,
  spaceId: string,
): Promise<PageResponse<BlockRow>> {
  const effectiveSource = sourceFilter === 'property:' ? null : sourceFilter
  return listBlocks({
    agendaDate: date,
    ...(effectiveSource != null && { agendaSource: effectiveSource }),
    ...(cursor != null && { cursor }),
    limit: listBlocksLimit(limit),
    spaceId,
  })
}

/**
 * Shared tail of the four "fetch → filter → batchResolve → merge titles"
 * effects in this hook. Skips when `ids` is empty, calls `batchResolve`,
 * checks the staleness flag again after the await, and finally hands the
 * resolved rows to `applyResolved`. Each call site retains its own merge
 * semantics (replace map vs. add-with-fallback vs. add-only-truthy) via
 * the callback so wire format stays byte-equivalent across migrations.
 */
export async function resolveAndMergeTitles(
  ids: string[],
  isStale: () => boolean,
  applyResolved: (resolved: ResolvedBlock[]) => void,
): Promise<void> {
  if (ids.length === 0) return
  const resolved = await batchResolve(ids)
  if (isStale()) return
  applyResolved(resolved)
}

export interface UseDuePanelDataOptions {
  date: string
  sourceFilter: string | null
  /**
   * Page id of the journal day whose own note is rendered above this
   * panel. Agenda items that live ON that page are filtered out so a
   * todo written in today's note isn't shown twice — once in the note
   * body, once in the Agenda list (UX live-review #7). `undefined`
   * disables the exclusion (e.g. past days that auto-create no page).
   */
  excludePageId?: string | undefined
}

export interface UseDuePanelDataReturn {
  blocks: BlockRow[]
  loading: boolean
  nextCursor: string | null
  hasMore: boolean
  totalCount: number
  pageTitles: Map<string, string>
  projectedEntries: ProjectedAgendaEntry[]
  projectedLoading: boolean
  overdueBlocks: BlockRow[]
  upcomingBlocks: BlockRow[]
  isToday: boolean
  warningDays: number
  loadMore: () => void
}

export function useDuePanelData({
  date,
  sourceFilter,
  excludePageId,
}: UseDuePanelDataOptions): UseDuePanelDataReturn {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const { invalidationKey } = useBlockPropertyEvents()
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  // Mirror `blocks` into a ref so `fetchBlocks` can compute
  // the merged paginated list (`prev + new items`) without keeping
  // `blocks` in its deps array. Updated on every render to stay in sync
  // with the latest committed state.
  const blocksRef = useRef<BlockRow[]>(blocks)
  blocksRef.current = blocks
  // #1531 — request token guarding `fetchBlocks` (loadMore) against a
  // date/source/space/invalidation change that lands mid-pagination. The main
  // fetch effect bumps it; `fetchBlocks` captures it at call time and discards
  // its result (and skips the title merge) if it no longer matches, so a stale
  // loadMore can't repopulate the just-cleared list with old-date blocks.
  const requestIdRef = useRef(0)
  const [projectedEntries, setProjectedEntries] = useState<ProjectedAgendaEntry[]>([])
  const [projectedLoading, setProjectedLoading] = useState(false)
  // #738 sub-3 — track the previous `invalidationKey` so the projected
  // cache is cleared ONLY when a property event actually fires (the key
  // changes), not on every effect re-run. The projected effect's deps
  // include `date` + `currentSpaceId`, so without this guard a plain
  // date navigation (after any prior property event) wiped the whole
  // 30s-TTL cache for the rest of the session, defeating.
  const prevInvalidationKeyRef = useRef(invalidationKey)
  const [overdueBlocks, setOverdueBlocks] = useState<BlockRow[]>([])
  const [upcomingBlocks, setUpcomingBlocks] = useState<BlockRow[]>([])

  const warningDays = useMemo(() => {
    try {
      const stored = localStorage.getItem('agaric:deadlineWarningDays')
      return stored ? Number.parseInt(stored, 10) : 0
    } catch {
      return 0
    }
  }, [])

  const todayStr = useToday()
  const isToday = date === todayStr

  // Fetch overdue blocks when showing today
  useEffect(() => {
    if (!isToday) {
      setOverdueBlocks([])
      return
    }
    let stale = false

    async function fetchOverdue() {
      try {
        // #738 sub-2 — push the date, DONE-exclusion, and content
        // filters into SQL so completed tasks and empty-content rows no
        // longer occupy the bounded fetch window and starve genuinely
        // overdue TODOs (the DonePanel pushes `contentNonEmpty` the same
        // way). The half-open `['0001-01-01', date)` window returns only
        // blocks whose `due_date` precedes `date`; `excludeTodoStates`
        // drops `DONE` rows at the DB layer (NULL-state rows survive);
        // `contentNonEmpty` drops empty/whitespace-only content.
        // The 200-row cap matches `PageRequest::new`'s `MAX_PAGE_SIZE`
        // (the silent clamp the previous `limit: 500` was hitting);
        // workspaces with more than 200 distinct overdue items would
        // need cursor pagination, which the Due panel doesn't surface.
        const resp = await queryByProperty({
          key: 'due_date',
          valueDateRange: ['0001-01-01', date],
          excludeTodoStates: ['DONE'],
          contentNonEmpty: true,
          limit: paginationLimit(200),
          spaceId: currentSpaceId,
        })
        if (stale) return

        // Defence-in-depth: the SQL push-down above already excludes
        // DONE / empty-content / on-or-after-`date` rows, but the
        // client predicate is retained so the visible set is correct
        // even if a stale backend ignores the new knob.
        const overdue = resp.items.filter(
          (b) => b.due_date && b.due_date < date && b.todo_state !== 'DONE' && b.content?.trim(),
        )
        setOverdueBlocks(overdue)

        if (overdue.length > 0) {
          await resolveAndMergeTitles(
            collectResolveIds(overdue),
            () => stale,
            (resolved) => {
              setPageTitles((prev) => {
                const next = new Map(prev)
                for (const r of resolved) {
                  next.set(r.id, r.title ?? 'Untitled')
                }
                return next
              })
            },
          )
        }
      } catch (err) {
        // Log overdue fetch failure to match the main/projected pattern.
        logger.warn('useDuePanelData', 'overdue fetch failed', { date }, err)
        if (!stale) setOverdueBlocks([])
      }
    }

    fetchOverdue()
    return () => {
      stale = true
    }
  }, [isToday, date, invalidationKey, currentSpaceId])

  // Fetch upcoming blocks (deadline approaching within warningDays)
  useEffect(() => {
    if (!isToday || warningDays <= 0) {
      setUpcomingBlocks([])
      return
    }
    let stale = false

    async function fetchUpcoming() {
      try {
        // Filter: due_date is between tomorrow and today + warningDays
        const tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        const tomorrowStr = formatDate(tomorrow)

        const endDate = new Date()
        endDate.setDate(endDate.getDate() + warningDays)
        const endStr = formatDate(endDate)

        // limit-clamp-followup — push the date filter into SQL via
        // `valueDateRange`.  `valueDateRange` is half-open `[start,
        // endExclusive)`, so we advance `endStr` by one day to keep
        // the inclusive last date in the result set (mirrors the
        // pattern in `agenda-filters.queryPropertyDateDimension`).
        // Limit reduced to 200 (the actual cap of `query_by_property`
        // via `PageRequest::new`); workspaces with more than 200
        // upcoming items in the warning window would need cursor
        // pagination, which the Due panel doesn't surface.
        const endExclusiveDate = new Date(`${endStr}T00:00:00`)
        endExclusiveDate.setDate(endExclusiveDate.getDate() + 1)
        const endExclusive = formatDate(endExclusiveDate)
        const resp = await queryByProperty({
          key: 'due_date',
          valueDateRange: [tomorrowStr, endExclusive],
          limit: paginationLimit(200),
          spaceId: currentSpaceId,
        })
        if (stale) return

        const upcoming = resp.items.filter(
          (b) =>
            b.due_date &&
            b.due_date >= tomorrowStr &&
            b.due_date <= endStr &&
            b.todo_state !== 'DONE' &&
            b.content?.trim(),
        )
        setUpcomingBlocks(upcoming)

        // Resolve parent titles
        if (upcoming.length > 0) {
          await resolveAndMergeTitles(
            collectResolveIds(upcoming),
            () => stale,
            (resolved) => {
              setPageTitles((prev) => {
                const next = new Map(prev)
                for (const r of resolved) {
                  if (r.title) next.set(r.id, r.title)
                }
                return next
              })
            },
          )
        }
      } catch (err) {
        // Log upcoming fetch failure to match the main/projected pattern.
        logger.warn('useDuePanelData', 'upcoming fetch failed', { date, warningDays }, err)
        if (!stale) setUpcomingBlocks([])
      }
    }

    fetchUpcoming()
    return () => {
      stale = true
    }
  }, [isToday, date, warningDays, invalidationKey, currentSpaceId])

  // Fetch blocks due on the given date.
  // `blocks` / `totalCount` / `pageTitles` are no longer in
  // the deps array; mutable state is read via functional setters
  // (`setTotalCount(prev => …)`, `setPageTitles(prev => …)`) and via
  // `blocksRef` for the paginated merge. Reduces callback churn and
  // closes the latent stale-closure footgun if a future maintainer
  // Dropped one of the deps. byte-equivalent map ordering is
  // preserved: `new Map(prev)` clones existing entries in insertion
  // order, the loop appends resolved entries in iteration order.
  const fetchBlocks = useCallback(
    async (cursor?: string) => {
      // #1531 — capture the active request token. If the date/source/space/
      // invalidation changes while this loadMore is in flight, the main effect
      // bumps `requestIdRef`, so we drop this stale result instead of appending
      // old-date blocks onto the just-cleared list.
      const myReqId = requestIdRef.current
      setLoading(true)
      try {
        // Phase 4 — `listBlocks` requires `spaceId`. The `?? ''`
        // fallback is intentional pre-bootstrap behaviour: empty string
        // forces a no-match SQL filter rather than a runtime null deref.
        const resp = await listBlocksForAgenda(date, sourceFilter, cursor, 50, currentSpaceId ?? '')
        if (myReqId !== requestIdRef.current) return
        const nonEmptyItems = applySourceFilter(resp.items, date, sourceFilter)
        const newBlocks = cursor ? [...blocksRef.current, ...nonEmptyItems] : nonEmptyItems
        setBlocks(newBlocks)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount((prev) => (cursor ? prev + nonEmptyItems.length : nonEmptyItems.length))

        const uniqueParentIds = [
          ...new Set(newBlocks.map((b) => b.page_id).filter((id): id is string => id != null)),
        ]
        await resolveAndMergeTitles(
          uniqueParentIds,
          () => myReqId !== requestIdRef.current,
          (resolved) => {
            setPageTitles((prev) => {
              const next = new Map(prev)
              for (const r of resolved) {
                next.set(r.id, r.title ?? 'Untitled')
              }
              return next
            })
          },
        )
      } catch (err) {
        logger.warn('useDuePanelData', 'fetchBlocks failed', { date }, err)
      } finally {
        // Only the request that still owns the token clears the shared loading
        // flag — a stale loadMore must not unset the loading state the newer
        // fetch set.
        if (myReqId === requestIdRef.current) setLoading(false)
      }
    },
    [date, sourceFilter, currentSpaceId],
  )

  // Fetch on mount and when date or sourceFilter changes
  useEffect(() => {
    // #1531 — invalidate any in-flight `fetchBlocks` (loadMore) so its result
    // can't repopulate the list we're about to clear with stale-date blocks.
    requestIdRef.current += 1
    setLoading(true)
    setBlocks([])
    setNextCursor(null)
    setHasMore(false)
    setTotalCount(0)
    setPageTitles(new Map())

    let cancelled = false
    const doFetch = async () => {
      try {
        // Phase 4 — `?? ''` is the pre-bootstrap no-match fallback.
        const resp = await listBlocksForAgenda(
          date,
          sourceFilter,
          undefined,
          50,
          currentSpaceId ?? '',
        )
        if (cancelled) return
        const nonEmptyItems = applySourceFilter(resp.items, date, sourceFilter)
        setBlocks(nonEmptyItems)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(nonEmptyItems.length)

        // Resolve parent page titles + inline ULID refs (B-53). Replaces
        // the map (initial fetch wipes pageTitles above).
        await resolveAndMergeTitles(
          collectResolveIds(nonEmptyItems),
          () => cancelled,
          (resolved) => setPageTitles(buildTitleMap(resolved, 'Untitled')),
        )
      } catch (err) {
        logger.warn('useDuePanelData', 'block fetch failed', undefined, err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    doFetch()
    return () => {
      cancelled = true
    }
  }, [date, sourceFilter, invalidationKey, currentSpaceId])

  // Fetch projected agenda entries with caching.
  // Phase 4 — cache key includes the active space so two
  // spaces don't share entries.
  useEffect(() => {
    let stale = false
    const cacheKey = `${currentSpaceId ?? '__null__'}|${date}`

    // #738 sub-3 — clear the projected cache ONLY when `invalidationKey`
    // actually changes (a property event fired since the last run), not
    // on every effect re-run. Comparing against the prev-value ref keeps
    // The 30s-TTL cache alive across plain date / space
    // navigations that don't carry a fresh invalidation.
    if (invalidationKey !== prevInvalidationKeyRef.current) {
      prevInvalidationKeyRef.current = invalidationKey
      projectedCache.clear()
    }

    // Serve cached data immediately if available
    const cached = projectedCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < PROJECTED_CACHE_TTL_MS) {
      setProjectedEntries(cached.entries.filter((e) => e.block.content?.trim()))
      setProjectedLoading(false)
      return
    }

    if (cached) {
      // Stale cache — evict so the map doesn't grow unbounded, then
      // show the now-stale data immediately while the refetch runs.
      projectedCache.delete(cacheKey)
      setProjectedEntries(cached.entries.filter((e) => e.block.content?.trim()))
    }

    setProjectedLoading(true)
    // `listProjectedAgenda` is cursor-paginated. The Due panel only
    // needs today's projected entries, which fit comfortably under the
    // limit, so this hook is first-page-only by design — `next_cursor`
    // and `has_more` are intentionally ignored.
    listProjectedAgenda({
      startDate: date,
      endDate: date,
      limit: listProjectedAgendaLimit(20),
      spaceId: currentSpaceId,
    })
      .then((response) => {
        if (!stale) {
          const entries = response.items
          // Update cache
          projectedCache.set(cacheKey, { entries, timestamp: Date.now() })
          // Filter out empty-content projected entries
          const nonEmptyEntries = entries.filter((e) => e.block.content?.trim())
          setProjectedEntries(nonEmptyEntries)
          const idsToResolve = collectResolveIds(nonEmptyEntries.map((e) => e.block))
          resolveAndMergeTitles(
            idsToResolve,
            () => stale,
            (resolved) => {
              setPageTitles((prev) => {
                const next = new Map(prev)
                for (const r of resolved) {
                  next.set(r.id, r.title ?? 'Untitled')
                }
                return next
              })
            },
          ).catch((err) => {
            // Skip side effects (logging, toast) if the effect has unmounted.
            if (stale) return
            logger.warn('useDuePanelData', 'nested agenda fetch failed', undefined, err)
            notify.error(t('duePanel.loadAgendaFailed'), { id: 'due-panel-load-failed' })
          })
        }
      })
      .catch((err) => {
        logger.warn('useDuePanelData', 'projected agenda fetch failed', undefined, err)
        // #757 (follow-up): the toast was outside the `!stale`
        // guard, firing after unmount. Skip state + toast once stale —
        // same contract as the nested handler above.
        if (stale) return
        setProjectedEntries([])
        notify.error(t('duePanel.loadAgendaFailed'), { id: 'due-panel-load-failed' })
      })
      .finally(() => {
        if (!stale) setProjectedLoading(false)
      })
    return () => {
      stale = true
    }
  }, [date, t, invalidationKey, currentSpaceId])

  const loadMore = useCallback(() => {
    if (nextCursor) {
      fetchBlocks(nextCursor)
    }
  }, [nextCursor, fetchBlocks])

  // UX live-review #7 — exclude agenda items that live on the journal
  // day's own page. The query layer (`listBlocks` agenda mode /
  // `query_by_property`) has no `excludeParentId` knob, so we scrub the
  // fetched lists here. Every downstream computation in DuePanel (the
  // "N Agenda" header count, per-source counts, grouping, projected
  // dedup, keyboard-nav flat list) derives from these returned arrays,
  // so a single filter keeps the count and the rendered rows consistent.
  // When `excludePageId` is undefined (e.g. a past day with no page),
  // the lists pass through unchanged.
  const filteredBlocks = useMemo(
    () => (excludePageId ? blocks.filter((b) => b.page_id !== excludePageId) : blocks),
    [blocks, excludePageId],
  )
  const filteredOverdueBlocks = useMemo(
    () =>
      excludePageId ? overdueBlocks.filter((b) => b.page_id !== excludePageId) : overdueBlocks,
    [overdueBlocks, excludePageId],
  )
  const filteredUpcomingBlocks = useMemo(
    () =>
      excludePageId ? upcomingBlocks.filter((b) => b.page_id !== excludePageId) : upcomingBlocks,
    [upcomingBlocks, excludePageId],
  )
  const filteredProjectedEntries = useMemo(
    () =>
      excludePageId
        ? projectedEntries.filter((e) => e.block.page_id !== excludePageId)
        : projectedEntries,
    [projectedEntries, excludePageId],
  )

  return {
    blocks: filteredBlocks,
    loading,
    nextCursor,
    hasMore,
    totalCount,
    pageTitles,
    projectedEntries: filteredProjectedEntries,
    projectedLoading,
    overdueBlocks: filteredOverdueBlocks,
    upcomingBlocks: filteredUpcomingBlocks,
    isToday,
    warningDays,
    loadMore,
  }
}
