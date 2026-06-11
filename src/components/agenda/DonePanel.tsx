/**
 * DonePanel -- shows blocks completed on a given date, grouped by source page.
 *
 * Renders on JournalPage below LinkedReferences. Groups blocks by parent page
 * (resolved via batchResolve). Within each group, sorts blocks by ID descending
 * (ULID ≈ most recently created first). Uses cursor-based pagination with
 * a `t('donePanel.loadMore')` button.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { CheckCircle2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  collectUniqueParentIds,
  groupBlocksByPage,
  mergeResolvedTitles,
} from '@/components/agenda/DonePanel.helpers'
import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { BlockListItem } from '@/components/editor/BlockListItem'
import { PageLink } from '@/components/pages/PageLink'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SectionGroupHeader } from '@/components/ui/section-group-header'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useKeyboardNavigableList } from '@/hooks/useKeyboardNavigableList'
import type { NavigateToPageFn } from '@/lib/block-events'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import type { BlockRow } from '@/lib/tauri'
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
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  // Fetch blocks completed on the given date.
  //
  // PEND-35 Tier 1.5 — `excludeParentId` and `contentNonEmpty` are
  // passed straight to the backend so cursor pagination, `total_count`,
  // and `t('donePanel.loadMore')` reflect the visible (post-filter) set instead of
  // the raw page. Previously the FE post-filtered each cursor page
  // (UX-129 / B-74) which silently broke the cursor accounting on
  // partial pages.
  const fetchBlocks = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        const resp = await queryByProperty({
          key: 'completed_at',
          valueDate: date,
          ...(cursor != null && { cursor }),
          limit: PAGINATION_LIMIT,
          spaceId: currentSpaceId,
          ...(excludePageId !== undefined && { excludeParentId: excludePageId }),
          contentNonEmpty: true,
        })
        const newBlocks = cursor ? [...blocks, ...resp.items] : resp.items
        setBlocks(newBlocks)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(cursor ? totalCount + resp.items.length : resp.items.length)

        // Resolve parent page titles
        const uniqueParentIds = collectUniqueParentIds(newBlocks)
        if (uniqueParentIds.length > 0) {
          const resolved = await batchResolve(uniqueParentIds)
          setPageTitles((prev) => mergeResolvedTitles(prev, resolved, t('donePanel.untitled')))
        }
      } catch (err) {
        logger.error('DonePanel', 'Failed to load done items', undefined, err)
      } finally {
        setLoading(false)
      }
    },
    [date, blocks, totalCount, t, excludePageId, currentSpaceId],
  )

  // oxlint-disable-next-line react-hooks/exhaustive-deps -- invalidationKey triggers refetch on property changes (F-39)
  useEffect(() => {
    setBlocks([])
    setNextCursor(null)
    setHasMore(false)
    setTotalCount(0)
    setPageTitles(new Map())
    setCollapsed(false)

    let cancelled = false
    const doFetch = async () => {
      setLoading(true)
      try {
        const resp = await queryByProperty({
          key: 'completed_at',
          valueDate: date,
          limit: PAGINATION_LIMIT,
          spaceId: currentSpaceId,
          // PEND-35 Tier 1.5 — push excludeParentId (B-74) and
          // contentNonEmpty (UX-129) into SQL so totalCount/hasMore
          // reflect the visible set rather than the raw page.
          ...(excludePageId !== undefined && { excludeParentId: excludePageId }),
          contentNonEmpty: true,
        })
        if (cancelled) return
        setBlocks(resp.items)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(resp.items.length)

        // Resolve parent page titles
        const uniqueParentIds = collectUniqueParentIds(resp.items)
        if (uniqueParentIds.length > 0) {
          const resolved = await batchResolve(uniqueParentIds)
          if (cancelled) return
          setPageTitles(mergeResolvedTitles(new Map(), resolved, t('donePanel.untitled')))
        }
      } catch (err) {
        if (!cancelled) {
          logger.error('DonePanel', 'Failed to load done items', undefined, err)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    doFetch()
    return () => {
      cancelled = true
    }
  }, [date, t, invalidationKey, excludePageId, currentSpaceId])

  const loadMore = useCallback(() => {
    if (nextCursor) {
      fetchBlocks(nextCursor)
    }
  }, [nextCursor, fetchBlocks])

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

  // ── Keyboard navigation (UX-138) ────────────────────────────────────
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

  // ── Virtualization (perf-review Tier 2 #6, 2026-05-14) ─────────────
  // The grouped panel is flattened into a single row list of
  // `{ kind: 'group-header' | 'item', ... }` so the virtualizer can
  // drop offscreen groups in their entirety instead of mounting every
  // sub-list. `flatItemIndex` threads each item row back to the
  // `flatItems` array used by keyboard navigation.
  type VirtualRow =
    | { kind: 'group-header'; key: string; pageId: string; title: string; count: number }
    | { kind: 'item'; key: string; block: BlockRow; flatItemIndex: number }

  const virtualRows = useMemo<VirtualRow[]>(() => {
    const rows: VirtualRow[] = []
    let flatIdx = 0
    for (const group of grouped) {
      rows.push({
        kind: 'group-header',
        key: `header:${group.pageId}`,
        pageId: group.pageId,
        title: group.title,
        count: group.items.length,
      })
      for (const block of group.items) {
        rows.push({
          kind: 'item',
          key: block.id,
          block,
          flatItemIndex: flatIdx++,
        })
      }
    }
    return rows
  }, [grouped])

  const scrollParentRef = useRef<HTMLDivElement>(null)

  // Header rows (~32px = SectionGroupHeader text + padding); item rows
  // (~44px = BlockListItem default + touch min-h-11). `measureElement`
  // corrects to actual height after first paint.
  const estimateSize = useCallback(
    (index: number) => {
      const row = virtualRows[index]
      if (row?.kind === 'group-header') return 32
      return 44
    },
    [virtualRows],
  )

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize,
    overscan: 5,
    getItemKey: (index) => virtualRows[index]?.key ?? index,
  })

  const flatToVirtualIndex = useMemo(() => {
    const map: number[] = []
    virtualRows.forEach((row, idx) => {
      if (row.kind === 'item') map[row.flatItemIndex] = idx
    })
    return map
  }, [virtualRows])

  useEffect(() => {
    if (focusedIndex < 0) return
    const idx = flatToVirtualIndex[focusedIndex]
    if (idx == null) return
    virtualizer.scrollToIndex(idx, { align: 'auto' })
  }, [focusedIndex, virtualizer, flatToVirtualIndex])

  const headerLabel =
    totalCount === 1 ? t('donePanel.headerOne') : t('donePanel.header', { count: totalCount })

  // UX-130 / UX empty-state mandate: render an EmptyState explaining
  // *why* the panel is empty rather than returning null. AGENTS.md/docs/UX.md
  // ban silent `return null` for empty panels.
  if (!loading && blocks.length === 0) {
    return (
      <section className="done-panel" aria-label={t('donePanel.completedItems')}>
        <EmptyState compact icon={CheckCircle2} message={t('donePanel.noneYet')} />
      </section>
    )
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
                // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keyboard nav container
                <div
                  className="done-panel-content mt-1"
                  ref={listRef}
                  // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard nav container
                  tabIndex={0}
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
                                  pageId={row.pageId}
                                  title={row.title}
                                  className="hover:underline"
                                />{' '}
                                ({row.count})
                              </SectionGroupHeader>
                            </li>
                          )
                        }
                        // Tier 1.4 (perf-review 2026-05-09): stable
                        // per-block handlers from `getRowHandlers` so
                        // `BlockListItem.memo` is not defeated by fresh
                        // inline-arrow identities.
                        const block = row.block
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
