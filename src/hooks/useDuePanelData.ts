/**
 * useDuePanelData — data fetching hook for DuePanel.
 *
 * Encapsulates the data fetches (the day's agenda rows, the open tasks,
 * projected) and their state management. Returns fetched data, loading states,
 * page titles, and a loadMore function.
 *
 * Extracted from DuePanel.tsx for testability (#651-R6).
 *
 * #2256 — deliberately NOT migrated onto `usePaginatedQuery`. Unlike the
 * other paginated panels (HistoryView / HistoryPanel / DonePanel each drive a
 * single cursor list), this hook is a
 * multi-source coordinator, not a thin cursor wrapper:
 *  - It runs distinct fetches (the day's agenda rows, the open tasks,
 *    projected agenda), merging all of their parent-title resolutions into a
 *    single shared `pageTitles` map.
 *  - `projected` uses a module-level 30s TTL cache keyed by space+date, and
 *    the open tasks are read to the end, so neither is a cursor list.
 * Forcing only the main-blocks sub-fetch through the hook would fracture this
 * coordinated state into a hybrid that is harder to reason about. The hook already carries its own
 * request-id stale-guard (#1531). Left as-is by design.
 */

import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useToday } from '@/hooks/useToday'
import { unwrap } from '@/lib/app-error'
import type { ActiveProjectedAgendaEntry, BlockRow, PageResponse } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { listBlocksLimit, listProjectedAgendaLimit, paginationLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/space-scope'
import { resolveTitles } from '@/stores/resolve-titles'
import { useSpaceStore } from '@/stores/space'

// ── ULID reference extraction (B-53) ──────────────────────────────────
/** Matches [[ULID]] (labelled or not, #5160 D9), #[ULID], and ((ULID)) refs inside block content. */
const ULID_REF_RE = /(?:\[\[|#\[|\(\()([0-9A-Z]{26})(?:\\?\|[^\]\n]*)?(?:\]\]|\]|\)\))/g

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
  entries: ActiveProjectedAgendaEntry[]
  timestamp: number
}

const projectedCache = new Map<string, ProjectedCacheEntry>()

/** @internal — exported for test isolation only. */
export function clearProjectedCache(): void {
  projectedCache.clear()
}

// ── Pure helpers ───────────────────────────────────────────

/** Drops blocks with empty or whitespace-only content. */
function nonEmpty(items: BlockRow[]): BlockRow[] {
  return items.filter((b) => b.content?.trim())
}

/**
 * Build a deduped list of block IDs to resolve titles for: every
 * non-null `page_id` plus every inline ULID reference found in content.
 */
export function collectResolveIds(blocks: BlockRow[]): string[] {
  const pageIds = blocks.map((b) => b.page_id).filter((id): id is string => id != null)
  const contentRefs = blocks.flatMap((b) => (b.content ? extractUlidRefs(b.content) : []))
  return [...new Set([...pageIds, ...contentRefs])]
}

/**
 * The day's agenda rows: every source (due, scheduled, a date property), open
 * or without a state. The DONE exclusion (#5074, `DonePanel` owns DONE) is in
 * SQL, not a client-side drop after the 50-row page cap, which would strand
 * every page behind one that is all DONE (#738).
 *
 * #2248 — `listBlocks` requires an active space; with none, resolve to an
 * empty page rather than throw in `requireActiveScope`.
 */
function listBlocksForAgenda(
  date: string,
  cursor: string | undefined,
  limit: number,
  spaceId: string | null,
): Promise<PageResponse<BlockRow>> {
  if (spaceId == null) {
    return Promise.resolve({
      items: [],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })
  }
  return commands
    .listBlocks(
      {
        parentId: null,
        blockType: null,
        tagId: null,
        date,
        dateRange: null,
        source: null,
        excludeTodoStates: ['DONE'],
        cursor: cursor ?? null,
        limit: listBlocksLimit(limit),
      },
      requireActiveScope(spaceId),
    )
    .then(unwrap)
}

/**
 * Shared tail of the "fetch → filter → resolve → merge titles" effects
 * in this hook: resolves `ids` and, unless `isStale()` after the await,
 * merges the titles into the shared map.
 */
export async function resolveAndMergeTitles(
  ids: string[],
  spaceId: string | null,
  isStale: () => boolean,
  setPageTitles: Dispatch<SetStateAction<Map<string, string>>>,
): Promise<void> {
  if (ids.length === 0 || spaceId == null) return
  const titles = await resolveTitles(spaceId, ids)
  if (isStale()) return
  setPageTitles((prev) => new Map([...prev, ...titles]))
}

export interface UseDuePanelDataOptions {
  date: string
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
  /** The day's agenda rows, every source, paginated by `loadMore`. */
  blocks: BlockRow[]
  loading: boolean
  hasMore: boolean
  pageTitles: Map<string, string>
  projectedEntries: ActiveProjectedAgendaEntry[]
  projectedLoading: boolean
  /** On today's page and later ones: every open task (TODO, DOING), dated or not. */
  openTasks: BlockRow[]
  openTasksLoading: boolean
  /** The page is today's or a later one's, which list every open task under tabs. */
  fromToday: boolean
  loadMore: () => void
}

const OPEN_TASK_STATES = ['TODO', 'DOING']

/** Every open task in the space, read page by page to the end. */
async function listOpenTasks(spaceId: string, isStale: () => boolean): Promise<BlockRow[]> {
  const scope = requireActiveScope(spaceId)
  const items: BlockRow[] = []
  let cursor: string | null = null
  do {
    const resp: PageResponse<BlockRow> = unwrap(
      await commands.queryByProperty(
        {
          key: 'todo_state',
          valueText: null,
          valueDate: null,
          operator: null,
          cursor,
          limit: paginationLimit(200),
          excludeParentId: null,
          contentNonEmpty: true,
          blockType: null,
          valueTextIn: OPEN_TASK_STATES,
          valueDateRange: null,
          excludeTodoStates: null,
        },
        scope,
      ),
    )
    if (isStale()) return items
    items.push(...resp.items)
    cursor = resp.next_cursor
  } while (cursor != null)
  return items
}

export function useDuePanelData({
  date,
  excludePageId,
}: UseDuePanelDataOptions): UseDuePanelDataReturn {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const { invalidationKey } = useBlockPropertyEvents()
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())
  // `fetchBlocks` appends to the committed list without `blocks` in its deps.
  const blocksRef = useRef<BlockRow[]>(blocks)
  useLayoutEffect(() => {
    blocksRef.current = blocks
  })
  // #1531 — request token guarding `fetchBlocks` (loadMore) against a
  // response for a date or space the panel has since left.
  const requestIdRef = useRef(0)
  const [projectedEntries, setProjectedEntries] = useState<ActiveProjectedAgendaEntry[]>([])
  const [projectedLoading, setProjectedLoading] = useState(false)
  const prevInvalidationKeyRef = useRef(invalidationKey)
  const [openTasks, setOpenTasks] = useState<BlockRow[]>([])
  const [openTasksLoading, setOpenTasksLoading] = useState(false)

  const todayStr = useToday()
  const fromToday = date >= todayStr

  useEffect(() => {
    if (!fromToday || currentSpaceId == null) {
      // oxlint-disable-next-line react/set-state-in-effect -- drops the open tasks when the panel moves to a past day; its rows only ever arrive from the `queryByProperty` IPC below; see #4407
      setOpenTasks([])
      setOpenTasksLoading(false)
      return
    }
    const spaceId = currentSpaceId
    let stale = false
    setOpenTasksLoading(true)
    listOpenTasks(spaceId, () => stale)
      .then(async (tasks) => {
        if (stale) return
        setOpenTasks(tasks)
        await resolveAndMergeTitles(collectResolveIds(tasks), spaceId, () => stale, setPageTitles)
      })
      .catch((err: unknown) => {
        logger.warn('useDuePanelData', 'open tasks fetch failed', { date }, err)
        if (!stale) setOpenTasks([])
      })
      .finally(() => {
        if (!stale) setOpenTasksLoading(false)
      })
    return () => {
      stale = true
    }
  }, [fromToday, date, invalidationKey, currentSpaceId])

  const fetchBlocks = useCallback(
    async (cursor?: string) => {
      const myReqId = requestIdRef.current
      setLoading(true)
      try {
        const resp = await listBlocksForAgenda(date, cursor, 50, currentSpaceId)
        if (myReqId !== requestIdRef.current) return
        const items = nonEmpty(resp.items)
        const newBlocks = cursor ? [...blocksRef.current, ...items] : items
        setBlocks(newBlocks)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        await resolveAndMergeTitles(
          collectResolveIds(items),
          currentSpaceId,
          () => myReqId !== requestIdRef.current,
          setPageTitles,
        )
      } catch (err) {
        logger.warn('useDuePanelData', 'fetchBlocks failed', { date }, err)
      } finally {
        if (myReqId === requestIdRef.current) setLoading(false)
      }
    },
    [date, currentSpaceId],
  )

  useEffect(() => {
    requestIdRef.current += 1
    // oxlint-disable-next-line react/set-state-in-effect -- marks the agenda refetch in flight as date or space changes, alongside the token bump that voids stale pages; see #4407
    setLoading(true)
    setBlocks([])
    setNextCursor(null)
    setHasMore(false)
    setPageTitles(new Map())

    let cancelled = false
    const doFetch = async () => {
      try {
        const resp = await listBlocksForAgenda(date, undefined, 50, currentSpaceId)
        if (cancelled) return
        const items = nonEmpty(resp.items)
        setBlocks(items)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        await resolveAndMergeTitles(
          collectResolveIds(items),
          currentSpaceId,
          () => cancelled,
          setPageTitles,
        )
      } catch (err) {
        logger.warn('useDuePanelData', 'block fetch failed', undefined, err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void doFetch()
    return () => {
      cancelled = true
    }
  }, [date, invalidationKey, currentSpaceId])

  // Fetch projected agenda entries with caching.
  // Phase 4 — cache key includes the active space so two
  // spaces don't share entries.
  useEffect(() => {
    // #5415 — no active space: nothing to project, never dispatch.
    if (currentSpaceId == null) return
    let stale = false
    const cacheKey = `${currentSpaceId}|${date}`

    // #738 sub-3 — clear the projected cache ONLY when `invalidationKey`
    // actually changes (a property event fired since the last run), not
    // on every effect re-run. Comparing against the prev-value ref keeps
    // The 30s-TTL cache alive across plain date / space
    // navigations that don't carry a fresh invalidation.
    if (invalidationKey !== prevInvalidationKeyRef.current) {
      prevInvalidationKeyRef.current = invalidationKey
      projectedCache.clear()
    }

    const resolveProjectedTitles = (entries: ActiveProjectedAgendaEntry[]) => {
      const idsToResolve = collectResolveIds(entries.map((entry) => entry.block))
      return resolveAndMergeTitles(idsToResolve, currentSpaceId, () => stale, setPageTitles).catch(
        (err) => {
          // Skip side effects (logging, toast) if the effect has unmounted.
          if (stale) return
          logger.warn('useDuePanelData', 'nested agenda fetch failed', undefined, err)
          notify.error(t('duePanel.loadAgendaFailed'), { id: 'due-panel-load-failed' })
        },
      )
    }

    // Serve cached data immediately if available
    const cached = projectedCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < PROJECTED_CACHE_TTL_MS) {
      const nonEmptyEntries = cached.entries.filter((e) => e.block.content?.trim())
      // oxlint-disable-next-line react/set-state-in-effect -- publishes a hit from the module-level 30s projected-agenda cache, an external store this render has no other access to; see #4407
      setProjectedEntries(nonEmptyEntries)
      setProjectedLoading(false)
      void resolveProjectedTitles(nonEmptyEntries)
      return () => {
        stale = true
      }
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
    commands
      .listProjectedAgenda(
        date,
        date,
        null,
        listProjectedAgendaLimit(20),
        requireActiveScope(currentSpaceId),
      )
      .then(unwrap)
      .then((response) => {
        if (!stale) {
          const entries = response.items
          // Update cache
          projectedCache.set(cacheKey, { entries, timestamp: Date.now() })
          // Filter out empty-content projected entries
          const nonEmptyEntries = entries.filter((e) => e.block.content?.trim())
          setProjectedEntries(nonEmptyEntries)
          void resolveProjectedTitles(nonEmptyEntries)
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
      void fetchBlocks(nextCursor)
    }
  }, [nextCursor, fetchBlocks])

  const filteredBlocks = useMemo(
    () => (excludePageId ? blocks.filter((b) => b.page_id !== excludePageId) : blocks),
    [blocks, excludePageId],
  )
  const filteredOpenTasks = useMemo(
    () => (excludePageId ? openTasks.filter((b) => b.page_id !== excludePageId) : openTasks),
    [openTasks, excludePageId],
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
    hasMore,
    pageTitles,
    projectedEntries: filteredProjectedEntries,
    projectedLoading,
    openTasks: filteredOpenTasks,
    openTasksLoading,
    fromToday,
    loadMore,
  }
}
