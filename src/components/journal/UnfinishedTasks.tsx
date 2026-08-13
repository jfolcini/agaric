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
import { Button } from '@/components/ui/button'
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

/**
 * The date used to place a block into an age bucket.
 *
 * Primary rule (unchanged): among `due_date` / `scheduled_date`, pick
 * whichever is chronologically PAST-MOST (`< todayStr`). The query returns
 * a task when EITHER date is in the past, and if the other date is future
 * it must not demote the task out of the bucket its genuinely-past date
 * belongs in — see the "past-most date wins" / "past scheduled date with a
 * future due date" tests below.
 *
 * #3841 — a blank string (`''`) is now EXCLUDED from that candidate set.
 * `'' < todayStr` is always true, so treating a blank `due_date` as a real
 * candidate made it win the past-most pick over a genuinely-past
 * `scheduled_date` every time (`''` sorts before any real date string) —
 * and the old code then discarded the block outright (`if (!dateStr)
 * continue`) because `''` is falsy. This is the exact same "`''` is not a
 * date" defect #3815/#3816 fixed for `agenda-sort.ts`'s `effectiveDate` and
 * this file's own `effectiveDisplayDate` (below); it had NOT been fixed
 * here despite sharing the root cause, because this bucket-selection logic
 * additionally has to preserve the past-most rule above it, which a
 * blanket switch to `effectiveDisplayDate` would NOT do — `due_date`
 * unconditionally beats `scheduled_date` there, which is wrong when
 * `due_date` is a real FUTURE date and `scheduled_date` is the genuinely
 * past, bucket-determining one.
 *
 * Fallback: if neither date qualifies as a real past date (both
 * blank/null, or the only date at all is blank) — latent, corrupted-data
 * territory per #3841/#3814, since every validated write path rejects
 * `''` — fall back to `effectiveDisplayDate`, and ultimately to
 * `todayStr`, so the block always resolves to SOME bucket rather than the
 * silent `continue` this replaces. `classifyAge(todayStr, todayStr)`
 * lands in "older" (matches neither "yesterday" nor "thisWeek"), a
 * deliberately conservative landing spot: the block stays visible instead
 * of asserting a probably-wrong recency.
 */
function bucketDateFor(block: BlockRow, todayStr: string): string {
  const past = [block.due_date, block.scheduled_date]
    .filter((date): date is string => date != null && date !== '' && date < todayStr)
    .toSorted()
    .at(0)
  if (past) return past
  // No REAL past date. Fall back so the block is still bucketed rather than
  // dropped (#3841). Both residual shapes land in `older` by construction —
  // `classifyAge` sends anything `>= todayStr` there, and `todayStr` itself
  // too — so a corrupted or future-dated row can never appear MORE recent
  // than it is. `older` is the least-alarming bucket, which is the right
  // direction to fail in; it also renders with no date badge, since blank
  // and null both suppress it.
  return effectiveDisplayDate(block) ?? todayStr
}

/** Group blocks by age: Yesterday, This Week, Older. */
function groupByAge(blocks: BlockRow[], todayStr: string): AgeGroup[] {
  const yesterday: BlockRow[] = []
  const thisWeek: BlockRow[] = []
  const older: BlockRow[] = []

  for (const block of blocks) {
    // #3841 — every block is now bucketed; none are silently dropped.
    const dateStr = bucketDateFor(block, todayStr)
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

/**
 * The date shown on a block's badge: `due_date`, falling back to
 * `scheduled_date`. Uses `||`, not `??` — a blank `due_date` (`''`) is a
 * valid `string`, so `??` would return it and never reach the fallback.
 * Ends `|| null` to match `effectiveDate` in `agenda-sort.ts` (#3815) for
 * real: without it, a block with `due_date: ''` AND `scheduled_date: ''`
 * would return `''` here vs. `null` there — harmless today (`BlockListItem`
 * guards `{dueDate && ...}`, so `''` renders no chip same as `null`), but a
 * caller relying on the documented parity would trip on it (#3845).
 *
 * Exported so this idiom can be pinned directly, and reused by
 * `bucketDateFor` (above) as the fallback once `groupByAge` has no
 * qualifying PAST date to bucket by. Before #3841, `groupByAge` dropped
 * such a block before it ever reached a render — either because its only
 * due/scheduled value was a blank string, OR because a blank `due_date` sat
 * ahead of a genuinely-past `scheduled_date` (`''` sorts before any real
 * date string, so a naive `.at(0)` picked the blank over the usable one) —
 * so a full-component test could not observe this expression on its own
 * (#3816). It can now: see the two `(#3841)` cases in the test file —
 * "renders a block whose due_date is blank but has a real scheduled_date…"
 * and "buckets a blank due_date with only a FUTURE scheduled_date under
 * Older…". They are `it` cases in the existing `describe`, not a describe
 * block of their own.
 */
export function effectiveDisplayDate(block: BlockRow): string | null {
  return block.due_date || block.scheduled_date || null
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
  const { data, isFetching, isError, hasNextPage, fetchNextPage, isFetchingNextPage, refetch } =
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
  //
  // #3342 — the drain is gated on the panel being EXPANDED. The rows only
  // exist inside `{!collapsed && …}`, and the panel is collapsed by default,
  // so a collapsed panel used to pay up to 25 sequential IPCs (and a
  // batch-resolve over every distinct page id) on every journal mount purely
  // to make the header badge exact. Collapsed now costs one page, and the
  // badge says "N+" while pages remain unloaded rather than lying about the
  // total.
  const shouldDrain = !collapsed
  const pageCount = data?.pages.length ?? 0
  // `!isError` stops the drain the moment a page rejects: `retry` is off on
  // the client, so a failed `fetchNextPage` leaves `hasNextPage` true (derived
  // from the last GOOD page) but will not re-fetch — without this guard the
  // effect would keep re-issuing a no-op `fetchNextPage` and, worse, the
  // `loading` derivation below would hang on the skeleton forever.
  const draining = shouldDrain && !isError && hasNextPage && pageCount < MAX_UNFINISHED_PAGES
  useEffect(() => {
    // `pageCount` is what advances the chain: a page settling is the event
    // that must re-run this effect (`isFetchingNextPage` can flip true→false
    // inside a single batched commit and be missed).
    if (!shouldDrain || isError || !hasNextPage || isFetchingNextPage) return
    if (pageCount >= MAX_UNFINISHED_PAGES) return
    void fetchNextPage()
  }, [shouldDrain, isError, hasNextPage, isFetchingNextPage, pageCount, fetchNextPage])

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
  //   • between-pages gap  → draining true                          → true
  //   • fully drained      → hasNextPage false & isFetching false   → false
  //   • cap hit (pages≥25) → draining false → loading=isFetching    → false
  //   • mid-drain failure  → isError true → draining false          → false
  //   • collapsed          → draining false → settles after page 1  → false
  const loading = isFetching || draining

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
  // Only while there is NOTHING to frame yet: once the panel exists, expanding
  // it starts a drain, and swapping the whole section out would unmount the
  // disclosure button the user just activated and drop focus to <body>. The
  // in-body skeleton below covers that case instead.
  if (loading && blocks.length === 0) {
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

  // A *failed* load gets an explicit error + retry affordance rather than the
  // `null` below (#3339, mirroring DonePanel and the #1345 AgendaView fix):
  // returning null made an IPC failure indistinguishable from "nothing is
  // overdue", which for a task app means silently dropping overdue work.
  if (isError && blocks.length === 0) {
    return (
      <section aria-label={t('unfinished.sectionLabel')} data-testid="unfinished-tasks-error">
        <div
          className="unfinished-tasks-error flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"
          role="alert"
        >
          <span>{t('unfinished.loadError')}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            aria-label={t('unfinished.retryLabel')}
          >
            {t('unfinished.retry')}
          </Button>
        </div>
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
          {hasNextPage ? t('unfinished.countPartial', { n: blocks.length }) : blocks.length}
          {/* `Badge` is a plain <span> (implicit role `generic`), which does not
              take `aria-label` — so the "at least N" qualifier has to be real
              text for AT rather than an attribute that is silently dropped.

              #3703 item 1 — the copy is gated on the collapsed state. "expand
              to load the rest" is the *visual* affordance's promise, and
              reading it out to someone whose panel is already open told them
              to perform an action they had already performed. Expanded, the
              badge can still be partial (the drain is mid-flight, the
              MAX_UNFINISHED_PAGES cap was hit, or a page rejected), so the
              qualifier is still needed — it just has to say what is actually
              true of an open panel. */}
          {hasNextPage && (
            <span className="sr-only">
              {collapsed
                ? t('unfinished.countPartialLabel', { n: blocks.length })
                : t('unfinished.countPartialLabelExpanded', { n: blocks.length })}
            </span>
          )}
        </Badge>
      </CollapsiblePanelHeader>

      {/* Mid-drain failure: pages 1..k are committed and rendered, but the
          list is truncated. Say so rather than presenting it as complete. */}
      {isError && (
        <div
          className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
          role="alert"
          data-testid="unfinished-tasks-partial-error"
        >
          <span>{t('unfinished.partialLoadError')}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            aria-label={t('unfinished.retryLabel')}
          >
            {t('unfinished.retry')}
          </Button>
        </div>
      )}

      {/* #3703 item 2 — the in-body skeleton is a live region.
          Confining the skeleton to the expanded body (rather than swapping the
          whole section out) is what keeps the disclosure button — and focus —
          alive across an expand-triggered drain, but it also means the load no
          longer replaces anything a screen reader was on, so nothing announced
          that the panel had started working. `role="status"` restores that
          signal without reintroducing the unmount; the visually-hidden text is
          what it has to announce, since a skeleton is all boxes and no words. */}
      {!collapsed && loading && (
        <div
          aria-busy="true"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- kept as role="status" so the in-body loading indicator is discoverable via [role="status"]; <output> drops the explicit attribute relied on by callers/tests
          role="status"
          data-testid="unfinished-tasks-body-loading"
          className="mt-1"
        >
          <span className="sr-only">{t('unfinished.loading')}</span>
          <LoadingSkeleton count={3} height="h-10" className="unfinished-tasks-loading" />
        </div>
      )}

      {!collapsed && !loading && (
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
                        dueDate={effectiveDisplayDate(block)}
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
