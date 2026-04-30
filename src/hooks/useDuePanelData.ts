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
import type { BlockRow, PageResponse, ProjectedAgendaEntry, ResolvedBlock } from '../lib/tauri'
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

// ── Pure helpers (MAINT-60) ───────────────────────────────────────────
// Factored out of doFetch/fetchBlocks to keep Biome cognitive-complexity
// bounded. Each helper is side-effect-free and independently testable.

/**
 * Apply the `property:` source filter (excludes blocks whose due_date or
 * scheduled_date matches the current agenda date) and drop blocks with
 * empty or whitespace-only content (UX-129). Other sourceFilter values
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
 */
function listBlocksForAgenda(
  date: string,
  sourceFilter: string | null,
  cursor: string | undefined,
  limit: number,
): Promise<PageResponse<BlockRow>> {
  const effectiveSource = sourceFilter === 'property:' ? null : sourceFilter
  return listBlocks({
    agendaDate: date,
    ...(effectiveSource != null && { agendaSource: effectiveSource }),
    ...(cursor != null && { cursor }),
    limit,
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
        const resp = await listBlocksForAgenda(date, sourceFilter, cursor, 50)
        const nonEmptyItems = applySourceFilter(resp.items, date, sourceFilter)
        const newBlocks = cursor ? [...blocks, ...nonEmptyItems] : nonEmptyItems
        setBlocks(newBlocks)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(cursor ? totalCount + nonEmptyItems.length : nonEmptyItems.length)

        // Resolve parent page titles. Uses the closed-over `pageTitles`
        // (not a functional update) to preserve byte-equivalent behaviour
        // with the pre-MAINT-129 implementation.
        const uniqueParentIds = [
          ...new Set(newBlocks.map((b) => b.page_id).filter((id): id is string => id != null)),
        ]
        await resolveAndMergeTitles(
          uniqueParentIds,
          () => false,
          (resolved) => {
            const titleMap = new Map(pageTitles)
            for (const r of resolved) {
              titleMap.set(r.id, r.title ?? 'Untitled')
            }
            setPageTitles(titleMap)
          },
        )
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
        const resp = await listBlocksForAgenda(date, sourceFilter, undefined, 50)
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
            logger.warn('useDuePanelData', 'nested agenda fetch failed', undefined, err)
            toast.error(t('duePanel.loadAgendaFailed'))
          })
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
