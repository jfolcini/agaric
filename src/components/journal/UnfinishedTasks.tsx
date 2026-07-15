/**
 * UnfinishedTasks — collapsible section showing open tasks from before today.
 *
 * Queries blocks with todo_state in ('TODO', 'DOING') that have a due_date
 * or scheduled_date before today. Groups results by age via the
 * `unfinished.yesterday` / `unfinished.thisWeek` / `unfinished.older` keys.
 */

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { BlockListItem } from '@/components/editor/BlockListItem'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useLocalStoragePreference } from '@/hooks/useLocalStoragePreference'
import { useToday } from '@/hooks/useToday'
import type { NavigateToPageFn } from '@/lib/block-events'
import { t as translate } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import type { BlockRow, PageResponse } from '@/lib/tauri'
import { batchResolve, listUnfinishedTasks, paginationLimit } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

// ── Constants ──────────────────────────────────────────────────────────

// #2227 — both persistence keys carry the shared `agaric:` prefix.
const COLLAPSED_STORAGE_KEY = 'agaric:unfinishedTasks.collapsed'
const GROUP_STORAGE_KEY = 'agaric:unfinishedTasks.groupCollapsed'
// Legacy (unprefixed) collapsed key, read once on mount to migrate existing
// users to the prefixed key without dropping their saved collapsed preference.
const LEGACY_COLLAPSED_STORAGE_KEY = 'unfinishedTasks.collapsed'

/**
 * Runaway guard for the cursor-drain loop (#757). Each page is capped at
 * 200 rows by `PageRequest::new`'s MAX_PAGE_SIZE, so 25 pages bounds the
 * section at 5000 tasks — far past any workspace where a flat "Older"
 * list is still useful, while keeping a hard stop if the backend ever
 * returned a non-advancing cursor.
 */
const MAX_UNFINISHED_PAGES = 25

// ── Types ──────────────────────────────────────────────────────────────

interface AgeGroup {
  key: string
  i18nKey: string
  blocks: BlockRow[]
}

export interface UnfinishedTasksProps {
  onNavigateToPage?: NavigateToPageFn | undefined
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD in local time (avoids UTC issues from toISOString). */
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Classify a date string into an age group relative to today. */
function classifyAge(dateStr: string, todayStr: string): 'yesterday' | 'thisWeek' | 'older' {
  const today = new Date(`${todayStr}T00:00:00`)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const yesterdayStr = toLocalDateStr(yesterday)

  if (dateStr === yesterdayStr) return 'yesterday'

  const weekAgo = new Date(today)
  weekAgo.setDate(today.getDate() - 7)
  const weekAgoStr = toLocalDateStr(weekAgo)

  // String comparison is valid because toLocalDateStr() guarantees YYYY-MM-DD format,
  // which is lexicographically sortable. All inputs to classifyAge() come from
  // toLocalDateStr() or the backend (which also uses YYYY-MM-DD).
  if (dateStr > weekAgoStr && dateStr < todayStr) return 'thisWeek'

  return 'older'
}

/** Group blocks by age: Yesterday, This Week, Older. */
function groupByAge(blocks: BlockRow[], todayStr: string): AgeGroup[] {
  const yesterday: BlockRow[] = []
  const thisWeek: BlockRow[] = []
  const older: BlockRow[] = []

  for (const block of blocks) {
    const dateStr = block.due_date ?? block.scheduled_date
    if (!dateStr) continue
    const age = classifyAge(dateStr, todayStr)
    if (age === 'yesterday') yesterday.push(block)
    else if (age === 'thisWeek') thisWeek.push(block)
    else older.push(block)
  }

  const groups: AgeGroup[] = []
  if (yesterday.length > 0)
    groups.push({
      key: 'yesterday',
      i18nKey: 'unfinished.yesterday',
      blocks: yesterday,
    })
  if (thisWeek.length > 0)
    groups.push({
      key: 'thisWeek',
      i18nKey: 'unfinished.thisWeek',
      blocks: thisWeek,
    })
  if (older.length > 0) groups.push({ key: 'older', i18nKey: 'unfinished.older', blocks: older })

  return groups
}

/**
 * One-time migration default for the collapsed toggle (#2227): read the legacy
 * (unprefixed) key so a user's saved collapsed state survives the move to the
 * `agaric:`-prefixed key. Only consulted when the prefixed key is absent (the
 * `useLocalStoragePreference` contract). Defaults to collapsed (true). The old
 * writer stored a bare `'true'`/`'false'` string, which is also valid JSON, so
 * it round-trips through the hook's default JSON parse unchanged.
 */
function readLegacyCollapsedDefault(): boolean {
  try {
    const legacy = localStorage.getItem(LEGACY_COLLAPSED_STORAGE_KEY)
    if (legacy === null) return true
    return legacy === 'true'
  } catch {
    return true
  }
}

/**
 * Parse the per-group collapsed map, dropping any non-boolean entries (and
 * rejecting non-object / array shapes). Mirrors the sanitisation the previous
 * bespoke reader performed so a corrupt/partial map can't feed a truthy string
 * into a group's collapsed flag. Invalid JSON is handled by
 * `useLocalStoragePreference` itself (falls back to the default).
 */
function parseGroupCollapsed(raw: string): Record<string, boolean> {
  const parsed = JSON.parse(raw) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const result: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') result[key] = value
  }
  return result
}

/** Resolve a set of page IDs to title map. Returns empty map on failure. */
async function resolvePageTitles(parentIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (parentIds.length === 0) return titles
  try {
    const resolved = await batchResolve(parentIds, 'global')
    for (const r of resolved) {
      titles.set(r.id, r.title ?? translate('common.untitled'))
    }
  } catch {
    // Non-critical: breadcrumbs will show "Untitled"
  }
  return titles
}

// ── Component ──────────────────────────────────────────────────────────

export function UnfinishedTasks({
  onNavigateToPage,
}: UnfinishedTasksProps): React.ReactElement | null {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  // Migration default computed once (reads the legacy unprefixed key); only
  // used when the prefixed key is absent.
  const [collapsedDefault] = useState(readLegacyCollapsedDefault)
  const [collapsed, setCollapsed] = useLocalStoragePreference<boolean>(
    COLLAPSED_STORAGE_KEY,
    collapsedDefault,
    { source: 'UnfinishedTasks' },
  )
  const [groupCollapsed, setGroupCollapsed] = useLocalStoragePreference<Record<string, boolean>>(
    GROUP_STORAGE_KEY,
    {},
    { parse: parseGroupCollapsed, source: 'UnfinishedTasks' },
  )
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  const todayStr = useToday()

  // #2634 — migrated off `usePaginatedQuery` (drain mode) onto TanStack
  // `useInfiniteQuery` directly (staged retirement of the generic hook; matching
  // the merged `DonePanel` / `useUnlinkedReferences` explicit-client pattern).
  // The query key carries the real fetch inputs (space / day), so a change to
  // either is a fresh query — reproducing the old request-id guard: a slow
  // rejection for a superseded space/day lands in that key's (now observer-less)
  // cache entry instead of clobbering the newer run's data (#826).
  const queryKey = useMemo(
    () => ['unfinishedTasks', currentSpaceId, todayStr],
    [currentSpaceId, todayStr],
  )
  const { data, isFetching, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(
      {
        queryKey,
        queryFn: async ({ pageParam }): Promise<PageResponse<BlockRow>> => {
          try {
            return await listUnfinishedTasks({
              beforeDate: todayStr,
              todoStates: ['TODO', 'DOING'],
              ...(pageParam != null && { cursor: pageParam }),
              limit: paginationLimit(200),
              spaceId: currentSpaceId,
            })
          } catch (err) {
            logger.warn('UnfinishedTasks', 'fetchUnfinished failed', undefined, err)
            throw err
          }
        },
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) =>
          last.has_more && last.next_cursor != null ? last.next_cursor : undefined,
        // usePaginatedQuery auto-loaded (drained) on every mount; preserve that.
        refetchOnMount: 'always',
        // Stale-while-revalidate parity: the old drain never cleared `blocks` on a
        // deps change — only a fresh commit overwrote them. Retained here for
        // consistency with the sibling migrations, but NOT load-bearing for this
        // panel: the `loading` skeleton (below) already gates the whole render
        // during a re-drain, so there is no visible list to keep alive.
        placeholderData: keepPreviousData,
        // Bound the cache: the key carries `todayStr`, which advances every
        // calendar day, so a session left open across many days would mint a new
        // (superseded, observer-less) entry per day and never collect it under the
        // client's `gcTime: Infinity`. A finite `gcTime` collects the prior day's
        // entry shortly after the rollover (same value/rationale as `DonePanel`).
        gcTime: 5 * 60 * 1000,
      },
      queryClient,
    )

  // DRAIN: auto-follow the `next_cursor` chain to completion, bounded by
  // MAX_UNFINISHED_PAGES (25) so a non-advancing backend cursor can't spin
  // forever (#757). This replaces the old hook's internal drain loop: each
  // settled page re-runs this effect, which fetches the next until the backend
  // reports no more pages (or the cap is hit).
  useEffect(() => {
    // `!isError` stops the drain the moment a page rejects: `retry` is off on
    // the client, so a failed `fetchNextPage` leaves `hasNextPage` true (derived
    // from the last GOOD page) but will not re-fetch — without this guard the
    // effect would keep re-issuing a no-op `fetchNextPage` and, worse, the
    // `loading` derivation below would hang on the skeleton forever.
    if (
      !isError &&
      hasNextPage &&
      !isFetchingNextPage &&
      (data?.pages.length ?? 0) < MAX_UNFINISHED_PAGES
    ) {
      void fetchNextPage()
    }
  }, [isError, hasNextPage, isFetchingNextPage, data, fetchNextPage])

  const blocks = useMemo<BlockRow[]>(() => data?.pages.flatMap((p) => p.items) ?? [], [data])

  // `loading` MUST stay true for the WHOLE drain: the component shows a skeleton
  // `if (loading)`, and the old drain kept loading true until the full set
  // committed in one go. `isFetching` covers the initial load and each in-flight
  // page; the second clause covers the brief between-pages settle window (a page
  // resolved, the next hasn't started yet) so the skeleton doesn't flicker to a
  // partial list mid-drain. The `!isError` guard is load-bearing: a page failing
  // mid-drain leaves `hasNextPage` true but no fetch in flight (retry off), so
  // without it `loading` would stay true forever and freeze the panel on its
  // skeleton — the old drain propagated the error and settled `loading` false,
  // degrading to the empty/partial render instead. Traces:
  //   • first load        → isFetching true                        → true
  //   • between-pages gap  → hasNextPage true & pages<25 & !error   → true
  //   • fully drained      → hasNextPage false & isFetching false   → false
  //   • cap hit (pages≥25) → second clause false → loading=isFetching → false
  //   • mid-drain failure  → isError true → second clause false → isFetching false → false
  const loading =
    isFetching || (!isError && hasNextPage && (data?.pages.length ?? 0) < MAX_UNFINISHED_PAGES)

  const { handleBlockClick, handleBlockKeyDown } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: t('unfinished.untitled'),
  })

  // Resolve page titles for breadcrumbs once the drained blocks are in. Kept
  // SEPARATE from the item fetch (mirrors DonePanel) so a title-resolve failure
  // surfaces blocks with an "Untitled" breadcrumb rather than failing the
  // section. `resolvePageTitles` swallows its own errors and returns an empty
  // map on failure, so the fallback is automatic. Titles are REPLACED (not
  // merged) so the map is rebuilt wholesale per load.
  //
  // Gated on `!loading`: unlike the old single-commit drain, `useInfiniteQuery`
  // commits each page incrementally, so `blocks` changes once per drained page.
  // Resolving on every intermediate `blocks` would fire N redundant `batchResolve`
  // IPCs per drain (with growing parent-id sets). Waiting for the drain to settle
  // restores the old one-resolve-per-load behaviour.
  useEffect(() => {
    if (loading) return
    const parentIds = [...new Set(blocks.map((b) => b.page_id).filter(Boolean))] as string[]
    if (parentIds.length === 0) {
      setPageTitles(new Map())
      return
    }
    let cancelled = false
    resolvePageTitles(parentIds).then((titles) => {
      if (!cancelled) setPageTitles(titles)
    })
    return () => {
      cancelled = true
    }
  }, [blocks, loading])

  const groups = useMemo(() => groupByAge(blocks, todayStr), [blocks, todayStr])

  const handleToggle = useCallback(() => {
    // `useLocalStoragePreference` persists the new value via its write effect.
    setCollapsed((prev) => !prev)
  }, [setCollapsed])

  const handleGroupToggle = useCallback(
    (key: string) => {
      setGroupCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
    },
    [setGroupCollapsed],
  )

  // Initial load: show a visible skeleton placeholder so sighted users see the
  // panel reserving space (rather than a blank gap that pops in when ready).
  if (loading) {
    return (
      <section
        aria-label={t('unfinished.loading')}
        aria-busy="true"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- intentional <section> landmark wrapping a block skeleton; <output> is inline phrasing-only and would drop the region semantics and break layout
        role="status"
        data-testid="unfinished-tasks-loading"
      >
        <LoadingSkeleton count={3} height="h-10" className="unfinished-tasks-loading" />
      </section>
    )
  }

  // Don't render section if no unfinished tasks
  if (blocks.length === 0) return null

  return (
    <section aria-label={t('unfinished.sectionLabel')} data-testid="unfinished-tasks">
      <CollapsiblePanelHeader isCollapsed={collapsed} onToggle={handleToggle}>
        {t('unfinished.title')}
        <Badge tone="secondary" className="ml-2">
          {blocks.length}
        </Badge>
      </CollapsiblePanelHeader>

      {!collapsed && (
        <div className="mt-1 space-y-3 animate-in fade-in-0 duration-normal">
          {groups.map((group) => {
            const isGroupCollapsed = groupCollapsed[group.key] ?? false
            return (
              <div key={group.key} data-testid={`unfinished-group-${group.key}`}>
                <CollapsiblePanelHeader
                  isCollapsed={isGroupCollapsed}
                  onToggle={() => handleGroupToggle(group.key)}
                  className="py-1"
                >
                  <span className="text-xs uppercase tracking-wide">{t(group.i18nKey)}</span>
                  <Badge tone="outline" className="ml-1.5 text-xs">
                    {group.blocks.length}
                  </Badge>
                </CollapsiblePanelHeader>

                {!isGroupCollapsed && (
                  <ul className="space-y-1 mt-1" aria-label={t(group.i18nKey)}>
                    {group.blocks.map((block) => (
                      <BlockListItem
                        key={block.id}
                        blockId={block.id}
                        content={block.content}
                        statusIconState={block.todo_state}
                        statusIconShowDone={false}
                        priority={block.priority}
                        priorityVariant="agenda"
                        dueDate={block.due_date ?? block.scheduled_date}
                        pageId={block.page_id}
                        pageTitle={pageTitles.get(block.page_id ?? '') ?? t('unfinished.untitled')}
                        breadcrumbArrow={t('unfinished.breadcrumbArrow')}
                        className="hover:bg-accent/50 active:bg-accent/70"
                        onClick={() => handleBlockClick(block)}
                        onKeyDown={(e) => handleBlockKeyDown(e, block)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
