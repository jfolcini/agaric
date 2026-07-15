/**
 * DonePanel -- shows blocks completed on a given date, grouped by source page.
 *
 * Renders on JournalPage below LinkedReferences. Groups blocks by parent page
 * (resolved via batchResolve). Within each group, sorts blocks by ID descending
 * (ULID ≈ most recently created first). Uses cursor-based pagination with
 * a `t('donePanel.loadMore')` button.
 */

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  collectUniqueParentIds,
  groupBlocksByPage,
  mergeResolvedTitles,
} from '@/components/agenda/DonePanel.helpers'
import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { BlockListItem } from '@/components/editor/BlockListItem'
import { PageLink } from '@/components/pages/PageLink'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SectionGroupHeader } from '@/components/ui/section-group-header'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useKeyboardNavigableList } from '@/hooks/useKeyboardNavigableList'
import { useVirtualizedGroupedRows } from '@/hooks/useVirtualizedGroupedRows'
import type { NavigateToPageFn } from '@/lib/block-events'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import type { BlockRow, PageResponse } from '@/lib/tauri'
import { batchResolve, queryByProperty } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

export interface DonePanelProps {
  date: string // YYYY-MM-DD
  onNavigateToPage?: NavigateToPageFn | undefined
  excludePageId?: string | undefined
}

export function DonePanel({
  date,
  onNavigateToPage,
  excludePageId,
}: DonePanelProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { invalidationKey } = useBlockPropertyEvents()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [collapsed, setCollapsed] = useState(false)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  // #2634 — migrated off `usePaginatedQuery` onto TanStack `useInfiniteQuery`
  // directly (staged retirement of the generic hook; matching the merged
  // `useBacklinkGroups` / `useUnlinkedReferences` pattern). The query key carries
  // the real fetch inputs (space / date / excludePageId / invalidationKey), so a
  // change to any is a fresh query — reproducing the old request-id guard: a late
  // load-more response for a superseded day/space lands in that key's (now
  // observer-less) cache entry instead of being grafted onto the new day's list
  // (#2210). `invalidationKey` (a block-property change) is a fetch input, so it
  // sits in the key to force a refetch when it bumps.
  //
  // `excludeParentId` and `contentNonEmpty` are passed straight to the backend so
  // cursor pagination, `has_more`, and the header count reflect the visible
  // (post-filter) set rather than the raw page (B-74). `queryByProperty` takes no
  // AbortSignal, so — as before migration — none is forwarded.
  const {
    data,
    isFetching,
    isError,
    error: queryError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery(
    {
      queryKey: [
        'donePanelCompleted',
        currentSpaceId,
        date,
        excludePageId ?? null,
        invalidationKey,
      ],
      queryFn: async ({ pageParam }): Promise<PageResponse<BlockRow>> => {
        try {
          return await queryByProperty({
            key: 'completed_at',
            valueDate: date,
            ...(pageParam != null && { cursor: pageParam }),
            limit: PAGINATION_LIMIT,
            spaceId: currentSpaceId,
            ...(excludePageId !== undefined && { excludeParentId: excludePageId }),
            contentNonEmpty: true,
          })
        } catch (err) {
          logger.error('DonePanel', 'Failed to load done items', undefined, err)
          throw err
        }
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => (lastPage.has_more ? lastPage.next_cursor : undefined),
      // usePaginatedQuery re-fetched page 1 on every mount; preserve that.
      refetchOnMount: 'always',
      // Stale-while-revalidate parity: usePaginatedQuery's deps-change path reset
      // the cursor but NEVER cleared `items` — only a successful response
      // overwrote them, so the list stayed visible during a refetch. With the
      // fetch inputs now in the query key, a change (esp. the debounced
      // `invalidationKey` on every `block:properties-changed`) switches to a
      // fresh empty entry; without this the completed list would blank to a
      // skeleton and lose scroll/focus on every task edit. `keepPreviousData`
      // retains the prior key's pages until the new fetch resolves (per-key
      // cache writes are unchanged, so the #2210 stale-guard still holds).
      // Mirrors the sibling `useAdvancedQuery` migration.
      placeholderData: keepPreviousData,
      // `invalidationKey` mints a new key on every block-property change; under
      // the client's `gcTime: Infinity` those superseded, observer-less entries
      // would accumulate unbounded over a long session. Bound the churn (mirrors
      // `useBacklinkGroups`): the active key keeps an observer while mounted and
      // is never collected; each prior key is evicted 5 min after going inactive.
      gcTime: 5 * 60 * 1000,
    },
    queryClient,
  )

  const blocks = useMemo<BlockRow[]>(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  // usePaginatedQuery's `loading` was true during ANY in-flight fetch (initial
  // AND load-more), driving both the skeleton and the LoadMoreButton busy state —
  // `isFetching` reproduces that (`isLoading` would be false during load-more).
  const loading = isFetching
  const hasMore = hasNextPage
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  // Surface the error/retry panel only on an INITIAL-load failure. In TanStack
  // v5 a fetch error flips `status` to `error` (→ `isError`) even when `data` is
  // retained (a failed load-more, or a failed refetch under keepPreviousData), so
  // `isError` alone is NOT an initial-vs-load-more discriminator. The render
  // gates the panel on `error != null && blocks.length === 0` — with items
  // present (real or placeholder) the panel stays hidden and the list stays
  // visible, matching the old hook's identical guard.
  const error = isError ? queryError : null

  // Resolve parent-page titles for the loaded blocks. Kept SEPARATE from the
  // item fetch so a title-resolve failure surfaces blocks with an "Untitled"
  // group header rather than failing the whole panel (the batchResolve rejection
  // must not propagate into the paginated-query error state). Titles are MERGED
  // (never rebuilt) so a later partial/failed resolve can't drop a title already
  // resolved for a still-visible page from an earlier cursor page.
  useEffect(() => {
    const uniqueParentIds = collectUniqueParentIds(blocks)
    if (uniqueParentIds.length === 0) return
    let cancelled = false
    batchResolve(uniqueParentIds, 'global')
      .then((resolved) => {
        if (cancelled) return
        setPageTitles((prev) => mergeResolvedTitles(prev, resolved, t('donePanel.untitled')))
      })
      .catch((err) => {
        // Non-critical: breadcrumbs / group headers fall back to "Untitled".
        logger.error('DonePanel', 'Failed to resolve page titles', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [blocks, t])

  // Re-expand the panel when the fetch identity changes (new day / space /
  // filter / block-property invalidation), matching the pre-refactor mount reset.
  useEffect(() => {
    setCollapsed(false)
  }, [date, invalidationKey, excludePageId, currentSpaceId])

  const retryLoad = useCallback(() => {
    void refetch()
  }, [refetch])

  // Accumulated visible count = number of loaded blocks (cursor pages append).
  const totalCount = blocks.length

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const { handleBlockClick, getRowHandlers } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: t('donePanel.untitled'),
  })

  // Group blocks by source page (parent_id → resolved page title)
  // Sort groups alphabetically by page title
  // Within each group, sort blocks by ID descending (ULID ≈ most recently created first)
  const grouped = useMemo(
    () => groupBlocksByPage(blocks, pageTitles, t('donePanel.untitled')),
    [blocks, pageTitles, t],
  )

  // ── Keyboard navigation ────────────────────────────────────
  const flatItems = useMemo(() => grouped.flatMap((g) => g.items), [grouped])

  const {
    focusedIndex,
    handleKeyDown: navHandleKeyDown,
    listRef,
  } = useKeyboardNavigableList<HTMLDivElement>(
    flatItems.length,
    (idx) => {
      const block = flatItems[idx]
      if (block) handleBlockClick(block)
    },
    { homeEnd: true, pageUpDown: true, resetKey: date },
  )

  // ── Virtualization (perf-review Tier 2 #6, 2026-05-14; #2252) ──────
  // Shared grouped-list scaffolding: `useVirtualizedGroupedRows` flattens
  // the grouped panel into header/item rows so the virtualizer can drop
  // offscreen groups in their entirety instead of mounting every
  // sub-list, threads `flatItemIndex` back to the keyboard-nav
  // `flatItems` array, and owns the focused-row scroll-into-view effect.
  const scrollParentRef = useRef<HTMLDivElement>(null)

  const { virtualRows, virtualizer } = useVirtualizedGroupedRows({
    groups: grouped,
    getGroupKey: (g) => g.pageId,
    getGroupItems: (g) => g.items,
    // Header rows ~32px (SectionGroupHeader text + padding); item rows
    // ~44px (BlockListItem default + touch min-h-11).
    headerHeight: 32,
    itemHeight: 44,
    focusedIndex,
    scrollParentRef,
  })

  const headerLabel =
    totalCount === 1 ? t('donePanel.headerOne') : t('donePanel.header', { count: totalCount })

  // A *failed* load gets an explicit error + retry affordance, distinct from
  // the empty `null` below — otherwise a thrown load is indistinguishable from
  // "no completed items today". Only surfaced when there's nothing to show
  // (an error on a load-more keeps the already-rendered items visible).
  if (error != null && blocks.length === 0) {
    return (
      <section className="done-panel" aria-label={t('donePanel.completedItems')}>
        <div
          className="done-panel-error flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"
          role="alert"
        >
          <span className="done-panel-error-message">{t('donePanel.loadError')}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={retryLoad}
            className="done-panel-retry"
            aria-label={t('donePanel.retryLabel')}
          >
            {t('donePanel.retry')}
          </Button>
        </div>
      </section>
    )
  }

  // Render nothing when empty (and not loading): an empty "none yet" panel is
  // visual clutter on every journal day. This intentionally overrides the older
  // Empty-state mandate for this panel (user decision, live UX review).
  // The loading branch stays so the panel doesn't flash an EmptyState mid-fetch.
  if (!loading && blocks.length === 0) {
    return null
  }

  return (
    <section className="done-panel" aria-label={t('donePanel.completedItems')}>
      <ListViewState
        loading={loading}
        items={blocks}
        skeleton={
          <div
            className="done-panel-loading flex items-center gap-2 px-2 py-2"
            aria-busy="true"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> defaults to display:inline and would break this flex skeleton container; keep role="status" on the div
            role="status"
          >
            <LoadingSkeleton count={3} height="h-10" />
          </div>
        }
        empty={null}
      >
        {() => {
          const virtualItems = virtualizer.getVirtualItems()
          const totalSize = virtualizer.getTotalSize()
          return (
            <>
              {/* Main header -- collapsible */}
              <CollapsiblePanelHeader
                isCollapsed={collapsed}
                onToggle={toggleCollapsed}
                className="done-panel-header"
              >
                {headerLabel}
              </CollapsiblePanelHeader>

              {!collapsed && (
                // #1520 — roving tabindex: the focused `BlockListItem` row is
                // the single tab stop (others are `tabIndex=-1`), so the
                // container must NOT carry `tabIndex={0}` or the list would
                // have a doubled keyboard model. The arrow-key handler stays
                // here and fires via keydown bubbling from the focused row.
                // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keyboard nav container (events bubble from the roving row); not itself focusable
                <div
                  className="done-panel-content mt-1"
                  ref={listRef}
                  onKeyDown={(e) => {
                    if (navHandleKeyDown(e)) e.preventDefault()
                  }}
                >
                  {/* Virtualized grouped list (perf-review Tier 2 #6).
                      Each virtual row is either a group-header `<li>`
                      or an item `<li>` (rendered by `BlockListItem`).
                      A single `<ul>` parent satisfies axe's `list`
                      rule across both kinds; flat-list virtualization
                      lets the windowing logic skip entire offscreen
                      groups instead of mounting every sub-list. */}
                  <ScrollArea
                    viewportRef={scrollParentRef}
                    viewportClassName="done-panel-scroll max-h-[calc(100dvh-260px)]"
                  >
                    {/* No aria-label here: the enclosing `<section>` is
                        already labelled `donePanel.completedItems`,
                        and the rows below carry their own semantics
                        (BlockListItem listitem + group-header `<li>`). */}
                    <ul
                      className="done-panel-blocks relative m-0 p-0 list-none"
                      style={{ height: `${totalSize}px` }}
                    >
                      {virtualItems.map((virtualRow) => {
                        const row = virtualRows[virtualRow.index]
                        if (!row) return null
                        const rowStyle: React.CSSProperties = {
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }
                        if (row.kind === 'group-header') {
                          return (
                            <li
                              key={virtualRow.key}
                              data-index={virtualRow.index}
                              ref={virtualizer.measureElement}
                              style={rowStyle}
                              className="done-panel-group-header-row"
                            >
                              <SectionGroupHeader className="done-panel-group-header bg-muted">
                                <PageLink
                                  pageId={row.group.pageId}
                                  title={row.group.title}
                                  className="hover:underline"
                                />{' '}
                                ({row.group.items.length})
                              </SectionGroupHeader>
                            </li>
                          )
                        }
                        // Tier 1.4 (perf-review 2026-05-09): stable
                        // per-block handlers from `getRowHandlers` so
                        // `BlockListItem.memo` is not defeated by fresh
                        // inline-arrow identities.
                        const block = row.item
                        const rowHandlers = getRowHandlers(block)
                        return (
                          <BlockListItem
                            key={virtualRow.key}
                            liRef={virtualizer.measureElement}
                            dataIndex={virtualRow.index}
                            style={rowStyle}
                            content={block.content}
                            // Typed metadata primitives — `BlockListItem`
                            // renders the `CheckCircle2` icon internally so
                            // the memo shallow-compare hits cleanly across
                            // parent re-renders (perf-review Tier 1.4
                            // metadata half, 2026-05-14).
                            showCompletedIcon
                            completedIconClassName="done-panel-check"
                            pageId={block.page_id}
                            pageTitle={
                              block.page_id
                                ? (pageTitles.get(block.page_id) ?? t('donePanel.untitled'))
                                : ''
                            }
                            breadcrumbArrow={t('donePanel.breadcrumbArrow')}
                            breadcrumbAsLink={false}
                            className="done-panel-item hover:bg-muted/50 active:bg-muted/70 ml-2"
                            contentClassName="done-panel-item-text"
                            breadcrumbClassName="done-panel-breadcrumb [@media(pointer:coarse)]:text-sm"
                            onClick={rowHandlers.onClick}
                            onKeyDown={rowHandlers.onKeyDown}
                            isFocused={focusedIndex === row.flatItemIndex}
                          />
                        )
                      })}
                    </ul>
                  </ScrollArea>

                  {/* Load more */}
                  <LoadMoreButton
                    hasMore={hasMore}
                    loading={loading}
                    onLoadMore={loadMore}
                    className="done-panel-load-more"
                    label={t('donePanel.loadMore')}
                    loadingLabel={t('donePanel.loading')}
                    ariaLabel={t('donePanel.loadMoreLabel')}
                    ariaLoadingLabel={t('donePanel.loadingMore')}
                  />
                </div>
              )}
            </>
          )
        }}
      </ListViewState>
    </section>
  )
}
