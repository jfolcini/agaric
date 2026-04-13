/**
 * DonePanel -- shows blocks completed on a given date, grouped by source page.
 *
 * Renders on JournalPage below LinkedReferences. Groups blocks by parent page
 * (resolved via batchResolve). Within each group, sorts blocks by ID descending
 * (ULID ≈ most recently created first). Uses cursor-based pagination with
 * "Load more" button.
 */

import { CheckCircle2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import { useBlockPropertyEvents } from '../hooks/useBlockPropertyEvents'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import type { NavigateToPageFn } from '../lib/block-events'
import { logger } from '../lib/logger'
import type { BlockRow } from '../lib/tauri'
import { batchResolve, queryByProperty } from '../lib/tauri'
import { BlockListItem } from './BlockListItem'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { ListViewState } from './ListViewState'
import { LoadMoreButton } from './LoadMoreButton'
import { PageLink } from './PageLink'

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
  const [blocks, setBlocks] = useState<BlockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [pageTitles, setPageTitles] = useState<Map<string, string>>(new Map())

  // Fetch blocks completed on the given date
  const fetchBlocks = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        const resp = await queryByProperty({
          key: 'completed_at',
          valueDate: date,
          ...(cursor != null && { cursor }),
          limit: 50,
        })
        // Filter out blocks with empty content (UX-129) and blocks from the excluded page (B-74)
        const nonEmptyItems = resp.items
          .filter((b) => b.content?.trim())
          .filter((b) => !excludePageId || b.parent_id !== excludePageId)
        const newBlocks = cursor ? [...blocks, ...nonEmptyItems] : nonEmptyItems
        setBlocks(newBlocks)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(cursor ? totalCount + nonEmptyItems.length : nonEmptyItems.length)

        // Resolve parent page titles
        const allBlocks = cursor ? [...blocks, ...nonEmptyItems] : nonEmptyItems
        const uniqueParentIds = [
          ...new Set(allBlocks.map((b) => b.parent_id).filter((id): id is string => id != null)),
        ]
        if (uniqueParentIds.length > 0) {
          const resolved = await batchResolve(uniqueParentIds)
          const titleMap = new Map(pageTitles)
          for (const r of resolved) {
            titleMap.set(r.id, r.title ?? t('donePanel.untitled'))
          }
          setPageTitles(titleMap)
        }
      } catch (err) {
        logger.error('DonePanel', 'Failed to load done items', undefined, err)
      } finally {
        setLoading(false)
      }
    },
    [date, blocks, totalCount, pageTitles, t, excludePageId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidationKey triggers refetch on property changes (F-39)
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
          limit: 50,
        })
        if (cancelled) return
        // Filter out blocks with empty content (UX-129) and blocks from the excluded page (B-74)
        const nonEmptyItems = resp.items
          .filter((b) => b.content?.trim())
          .filter((b) => !excludePageId || b.parent_id !== excludePageId)
        setBlocks(nonEmptyItems)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(nonEmptyItems.length)

        // Resolve parent page titles
        const uniqueParentIds = [
          ...new Set(
            nonEmptyItems.map((b) => b.parent_id).filter((id): id is string => id != null),
          ),
        ]
        if (uniqueParentIds.length > 0) {
          const resolved = await batchResolve(uniqueParentIds)
          if (cancelled) return
          const titleMap = new Map<string, string>()
          for (const r of resolved) {
            titleMap.set(r.id, r.title ?? t('donePanel.untitled'))
          }
          setPageTitles(titleMap)
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
  }, [date, t, invalidationKey, excludePageId])

  const loadMore = useCallback(() => {
    if (nextCursor) {
      fetchBlocks(nextCursor)
    }
  }, [nextCursor, fetchBlocks])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const { handleBlockClick, handleBlockKeyDown } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: t('donePanel.untitled'),
  })

  // Group blocks by source page (parent_id → resolved page title)
  // Sort groups alphabetically by page title
  // Within each group, sort blocks by ID descending (ULID ≈ most recently created first)
  const grouped = (() => {
    const groupMap = new Map<string, { pageId: string; title: string; items: BlockRow[] }>()
    for (const block of blocks) {
      const pageId = block.parent_id ?? '__none__'
      const title = block.parent_id
        ? (pageTitles.get(block.parent_id) ?? t('donePanel.untitled'))
        : t('donePanel.untitled')
      if (!groupMap.has(pageId)) {
        groupMap.set(pageId, { pageId, title, items: [] })
      }
      groupMap.get(pageId)?.items.push(block)
    }
    // Sort groups alphabetically by title
    const groups = [...groupMap.values()].sort((a, b) => a.title.localeCompare(b.title))
    // Sort blocks within each group by ID descending
    for (const group of groups) {
      group.items.sort((a, b) => b.id.localeCompare(a.id))
    }
    return groups
  })()

  // ── Keyboard navigation (UX-138) ────────────────────────────────────
  const listRef = useRef<HTMLDivElement>(null)
  const flatItems = grouped.flatMap((g) => g.items)

  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: flatItems.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const block = flatItems[idx]
      if (block) handleBlockClick(block)
    },
  })

  // Reset focused index when date changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    setFocusedIndex(0)
  }, [date, setFocusedIndex])

  // Scroll focused item into view
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-block-list-item]')
    const el = items[focusedIndex] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [focusedIndex])

  const headerLabel =
    totalCount === 1 ? t('donePanel.headerOne') : t('donePanel.header', { count: totalCount })

  // UX-130: Don't render panel when no completed items
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
            role="status"
          >
            <LoadingSkeleton count={3} height="h-10" />
          </div>
        }
        empty={null}
      >
        {() => {
          let flatIndex = 0
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
                // biome-ignore lint/a11y/noStaticElementInteractions: keyboard nav container
                <div
                  className="done-panel-content mt-1 space-y-2"
                  ref={listRef}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard nav container
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (navHandleKeyDown(e)) e.preventDefault()
                  }}
                >
                  {/* Grouped blocks */}
                  {grouped.map((group) => (
                    <div key={group.pageId} className="done-panel-group">
                      {/* Group sub-header: page title + block count (not individually collapsible) */}
                      <div className="done-panel-group-header px-3 py-1 text-xs [@media(pointer:coarse)]:text-sm font-semibold text-muted-foreground tracking-wide uppercase bg-muted rounded">
                        <PageLink
                          pageId={group.pageId}
                          title={group.title}
                          className="hover:underline"
                        />{' '}
                        ({group.items.length})
                      </div>

                      <ul
                        className="done-panel-blocks ml-2 space-y-1"
                        aria-label={t('donePanel.groupItemsLabel', { title: group.title })}
                      >
                        {group.items.map((block) => {
                          const currentFlatIndex = flatIndex++
                          return (
                            <BlockListItem
                              key={block.id}
                              content={block.content}
                              metadata={
                                <CheckCircle2 className="done-panel-check h-4 w-4 shrink-0 text-status-done-foreground" />
                              }
                              pageId={block.parent_id}
                              pageTitle={
                                block.parent_id
                                  ? (pageTitles.get(block.parent_id) ?? t('donePanel.untitled'))
                                  : ''
                              }
                              breadcrumbArrow={t('donePanel.breadcrumbArrow')}
                              breadcrumbAsLink={false}
                              className="done-panel-item hover:bg-muted/50 active:bg-muted/70"
                              contentClassName="done-panel-item-text"
                              breadcrumbClassName="done-panel-breadcrumb [@media(pointer:coarse)]:text-sm"
                              onClick={() => handleBlockClick(block)}
                              onKeyDown={(e) => handleBlockKeyDown(e, block)}
                              isFocused={focusedIndex === currentFlatIndex}
                            />
                          )
                        })}
                      </ul>
                    </div>
                  ))}

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
