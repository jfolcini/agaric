/**
 * useDuePanelData — data fetching hook for DuePanel.
 *
 * Encapsulates the 3 data fetches (blocks, overdue, upcoming, projected)
 * and their state management. Returns fetched data, loading states,
 * page titles, and a loadMore function.
 *
 * Extracted from DuePanel.tsx for testability (#651-R6).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { formatDate, getTodayString } from '@/lib/date-utils'
import { logger } from '../lib/logger'
import type { BlockRow, ProjectedAgendaEntry } from '../lib/tauri'
import { batchResolve, listBlocks, listProjectedAgenda, queryByProperty } from '../lib/tauri'
import { useBlockPropertyEvents } from './useBlockPropertyEvents'

// ── ULID reference extraction (B-53) ──────────────────────────────────
/** Matches [[ULID]], #[ULID], and ((ULID)) refs inside block content. */
const ULID_REF_RE = /(?:\[\[|#\[|\(\()([0-9A-Z]{26})(?:\]\]|\]|\)\))/g

/** Extract all ULID references from a string. */
export function extractUlidRefs(text: string): string[] {
  const ids: string[] = []
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = ULID_REF_RE.exec(text)) !== null) {
    const id = m[1] as string
    ids.push(id)
  }
  return ids
}

// ── Module-level cache for projected agenda (UX-114) ──────────────────
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

export interface UseDuePanelDataOptions {
  date: string
  sourceFilter: string | null
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
}: UseDuePanelDataOptions): UseDuePanelDataReturn {
  const { t } = useTranslation()
  const { invalidationKey } = useBlockPropertyEvents()
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  const [projectedEntries, setProjectedEntries] = useState<ProjectedAgendaEntry[]>([])
  const [projectedLoading, setProjectedLoading] = useState(false)
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

  const todayStr = useMemo(() => getTodayString(), [])
  const isToday = date === todayStr

  // Fetch overdue blocks when showing today
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — refetch on property change (B-50/F-39)
  useEffect(() => {
    if (!isToday) {
      setOverdueBlocks([])
      return
    }
    let stale = false

    async function fetchOverdue() {
      try {
        const resp = await queryByProperty({ key: 'due_date', limit: 500 })
        if (stale) return

        const overdue = resp.items.filter(
          (b) => b.due_date && b.due_date < date && b.todo_state !== 'DONE' && b.content?.trim(),
        )
        setOverdueBlocks(overdue)

        if (overdue.length > 0) {
          const contentRefs = overdue.flatMap((b) => (b.content ? extractUlidRefs(b.content) : []))
          const idsToResolve = [
            ...new Set([
              ...overdue.map((b) => b.page_id).filter((id): id is string => id != null),
              ...contentRefs,
            ]),
          ]
          if (idsToResolve.length > 0) {
            const resolved = await batchResolve(idsToResolve)
            if (!stale) {
              setPageTitles((prev) => {
                const next = new Map(prev)
                for (const r of resolved) {
                  next.set(r.id, r.title ?? 'Untitled')
                }
                return next
              })
            }
          }
        }
      } catch {
        if (!stale) setOverdueBlocks([])
      }
    }

    fetchOverdue()
    return () => {
      stale = true
    }
  }, [isToday, date, invalidationKey])

  // Fetch upcoming blocks (deadline approaching within warningDays)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — refetch on property change (B-50/F-39)
  useEffect(() => {
    if (!isToday || warningDays <= 0) {
      setUpcomingBlocks([])
      return
    }
    let stale = false

    async function fetchUpcoming() {
      try {
        const resp = await queryByProperty({ key: 'due_date', limit: 500 })
        if (stale) return

        // Filter: due_date is between tomorrow and today + warningDays
        const tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        const tomorrowStr = formatDate(tomorrow)

        const endDate = new Date()
        endDate.setDate(endDate.getDate() + warningDays)
        const endStr = formatDate(endDate)

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
          const contentRefs = upcoming.flatMap((b) => (b.content ? extractUlidRefs(b.content) : []))
          const idsToResolve = [
            ...new Set([
              ...upcoming.map((b) => b.page_id).filter((id): id is string => id != null),
              ...contentRefs,
            ]),
          ]
          if (idsToResolve.length > 0) {
            const titles = await batchResolve(idsToResolve)
            if (!stale) {
              setPageTitles((prev) => {
                const next = new Map(prev)
                for (const r of titles) {
                  if (r.title) next.set(r.id, r.title)
                }
                return next
              })
            }
          }
        }
      } catch {
        if (!stale) setUpcomingBlocks([])
      }
    }

    fetchUpcoming()
    return () => {
      stale = true
    }
  }, [isToday, warningDays, invalidationKey])

  // Fetch blocks due on the given date
  const fetchBlocks = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        const effectiveSource = sourceFilter === 'property:' ? null : sourceFilter
        const resp = await listBlocks({
          agendaDate: date,
          ...(effectiveSource != null && { agendaSource: effectiveSource }),
          ...(cursor != null && { cursor }),
          limit: 50,
        })
        const filteredItems =
          sourceFilter === 'property:'
            ? resp.items.filter((b) => b.due_date !== date && b.scheduled_date !== date)
            : resp.items
        // Filter out blocks with empty content (UX-129)
        const nonEmptyItems = filteredItems.filter((b) => b.content?.trim())
        const newBlocks = cursor ? [...blocks, ...nonEmptyItems] : nonEmptyItems
        setBlocks(newBlocks)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(cursor ? totalCount + nonEmptyItems.length : nonEmptyItems.length)

        // Resolve parent page titles
        const allBlocks = cursor ? [...blocks, ...nonEmptyItems] : nonEmptyItems
        const uniqueParentIds = [
          ...new Set(allBlocks.map((b) => b.page_id).filter((id): id is string => id != null)),
        ]
        if (uniqueParentIds.length > 0) {
          const resolved = await batchResolve(uniqueParentIds)
          const titleMap = new Map(pageTitles)
          for (const r of resolved) {
            titleMap.set(r.id, r.title ?? 'Untitled')
          }
          setPageTitles(titleMap)
        }
      } catch (err) {
        logger.warn('useDuePanelData', 'fetchBlocks failed', { date }, err)
      } finally {
        setLoading(false)
      }
    },
    [date, blocks, totalCount, pageTitles, sourceFilter],
  )

  // Fetch on mount and when date or sourceFilter changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — refetch on property change (B-50/F-39)
  useEffect(() => {
    setLoading(true)
    setBlocks([])
    setNextCursor(null)
    setHasMore(false)
    setTotalCount(0)
    setPageTitles(new Map())

    let cancelled = false
    const doFetch = async () => {
      try {
        const effectiveSource = sourceFilter === 'property:' ? null : sourceFilter
        const resp = await listBlocks({
          agendaDate: date,
          ...(effectiveSource != null && { agendaSource: effectiveSource }),
          limit: 50,
        })
        if (cancelled) return
        const items =
          sourceFilter === 'property:'
            ? resp.items.filter((b) => b.due_date !== date && b.scheduled_date !== date)
            : resp.items
        // Filter out blocks with empty content (UX-129)
        const nonEmptyItems = items.filter((b) => b.content?.trim())
        setBlocks(nonEmptyItems)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(nonEmptyItems.length)

        // Resolve parent page titles + inline ULID refs (B-53)
        const contentRefs = nonEmptyItems.flatMap((b) =>
          b.content ? extractUlidRefs(b.content) : [],
        )
        const idsToResolve = [
          ...new Set([
            ...nonEmptyItems.map((b) => b.page_id).filter((id): id is string => id != null),
            ...contentRefs,
          ]),
        ]
        if (idsToResolve.length > 0) {
          const resolved = await batchResolve(idsToResolve)
          if (cancelled) return
          const titleMap = new Map<string, string>()
          for (const r of resolved) {
            titleMap.set(r.id, r.title ?? 'Untitled')
          }
          setPageTitles(titleMap)
        }
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
  }, [date, sourceFilter, invalidationKey])

  // Fetch projected agenda entries with caching (UX-114)
  useEffect(() => {
    let stale = false
    const cacheKey = date

    // When invalidationKey changes, clear the projected cache so we refetch fresh data
    if (invalidationKey > 0) {
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
      // Stale cache — show immediately but refetch
      setProjectedEntries(cached.entries.filter((e) => e.block.content?.trim()))
    }

    setProjectedLoading(true)
    listProjectedAgenda({ startDate: date, endDate: date, limit: 20 })
      .then((entries) => {
        if (!stale) {
          // Update cache
          projectedCache.set(cacheKey, { entries, timestamp: Date.now() })
          // Filter out empty-content projected entries (UX-129)
          const nonEmptyEntries = entries.filter((e) => e.block.content?.trim())
          setProjectedEntries(nonEmptyEntries)
          const contentRefs = nonEmptyEntries.flatMap((e) =>
            e.block.content ? extractUlidRefs(e.block.content) : [],
          )
          const idsToResolve = [
            ...new Set([
              ...nonEmptyEntries
                .map((e) => e.block.page_id)
                .filter((id): id is string => id != null),
              ...contentRefs,
            ]),
          ]
          if (idsToResolve.length > 0) {
            batchResolve(idsToResolve)
              .then((resolved) => {
                if (!stale) {
                  setPageTitles((prev) => {
                    const next = new Map(prev)
                    for (const r of resolved) {
                      next.set(r.id, r.title ?? 'Untitled')
                    }
                    return next
                  })
                }
              })
              .catch((err) => {
                logger.warn('useDuePanelData', 'nested agenda fetch failed', undefined, err)
                toast.error(t('duePanel.loadAgendaFailed'))
              })
          }
        }
      })
      .catch((err) => {
        logger.warn('useDuePanelData', 'projected agenda fetch failed', undefined, err)
        if (!stale) setProjectedEntries([])
        toast.error(t('duePanel.loadAgendaFailed'))
      })
      .finally(() => {
        if (!stale) setProjectedLoading(false)
      })
    return () => {
      stale = true
    }
  }, [date, t, invalidationKey])

  const loadMore = useCallback(() => {
    if (nextCursor) {
      fetchBlocks(nextCursor)
    }
  }, [nextCursor, fetchBlocks])

  return {
    blocks,
    loading,
    nextCursor,
    hasMore,
    totalCount,
    pageTitles,
    projectedEntries,
    projectedLoading,
    overdueBlocks,
    upcomingBlocks,
    isToday,
    warningDays,
    loadMore,
  }
}
