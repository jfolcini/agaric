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
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import type { NavigateToPageFn } from '../lib/block-events'
import type { BlockRow } from '../lib/tauri'
import { batchResolve, queryByProperty } from '../lib/tauri'
import { truncateContent } from '../lib/text-utils'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'
import { PageLink } from './PageLink'

export interface DonePanelProps {
  date: string // YYYY-MM-DD
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function DonePanel({ date, onNavigateToPage }: DonePanelProps): React.ReactElement | null {
  const { t } = useTranslation()
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
        const newBlocks = cursor ? [...blocks, ...resp.items] : resp.items
        setBlocks(newBlocks)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(cursor ? totalCount + resp.items.length : resp.items.length)

        // Resolve parent page titles
        const allBlocks = cursor ? [...blocks, ...resp.items] : resp.items
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
      } catch {
        // Silently handle errors
      } finally {
        setLoading(false)
      }
    },
    [date, blocks, totalCount, pageTitles, t],
  )

  // Fetch on mount and when date changes
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
        setBlocks(resp.items)
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(resp.items.length)

        // Resolve parent page titles
        const uniqueParentIds = [
          ...new Set(resp.items.map((b) => b.parent_id).filter((id): id is string => id != null)),
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
      } catch {
        // Silently handle errors
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    doFetch()
    return () => {
      cancelled = true
    }
  }, [date, t])

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

  // Empty state: show EmptyState component
  if (!loading && totalCount === 0 && blocks.length === 0) {
    return (
      <section className="done-panel" aria-label={t('donePanel.completedItems')}>
        <EmptyState icon={CheckCircle2} message={t('donePanel.empty')} compact />
      </section>
    )
  }

  const headerLabel =
    totalCount === 1 ? t('donePanel.headerOne') : t('donePanel.header', { count: totalCount })

  return (
    <section className="done-panel" aria-label={t('donePanel.completedItems')}>
      {/* Main header -- collapsible */}
      <CollapsiblePanelHeader
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        className="done-panel-header"
      >
        {headerLabel}
      </CollapsiblePanelHeader>

      {!collapsed && (
        <div className="done-panel-content mt-1 space-y-2">
          {/* Loading spinner */}
          {loading && blocks.length === 0 && (
            <div
              className="done-panel-loading flex items-center gap-2 px-2 py-2"
              aria-busy="true"
              role="status"
            >
              <LoadingSkeleton count={3} height="h-10" />
            </div>
          )}

          {/* Grouped blocks */}
          {grouped.map((group) => (
            <div key={group.pageId} className="done-panel-group">
              {/* Group sub-header: page title + block count (not individually collapsible) */}
              <div className="done-panel-group-header px-3 py-1 text-xs [@media(pointer:coarse)]:text-sm font-semibold text-muted-foreground tracking-wide uppercase bg-muted rounded">
                <PageLink pageId={group.pageId} title={group.title} className="hover:underline" /> (
                {group.items.length})
              </div>

              <ul
                className="done-panel-blocks ml-2 space-y-1"
                aria-label={t('donePanel.groupItemsLabel', { title: group.title })}
              >
                {group.items.map((block) => (
                  <li
                    key={block.id}
                    className="done-panel-item flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer hover:bg-muted/50 active:bg-muted/70 transition-colors"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
                    tabIndex={0}
                    onClick={() => handleBlockClick(block)}
                    onKeyDown={(e) => handleBlockKeyDown(e, block)}
                  >
                    {/* Check icon (green) */}
                    <CheckCircle2 className="done-panel-check h-4 w-4 shrink-0 text-green-600" />

                    {/* Block content */}
                    <span className="done-panel-item-text text-sm min-w-0 flex-1 truncate">
                      {truncateContent(block.content)}
                    </span>

                    {/* Source page breadcrumb */}
                    {block.parent_id && (
                      <span className="done-panel-breadcrumb text-xs [@media(pointer:coarse)]:text-sm text-muted-foreground truncate max-w-[40%]">
                        {t('donePanel.breadcrumbArrow')}{' '}
                        {pageTitles.get(block.parent_id) ?? t('donePanel.untitled')}
                      </span>
                    )}
                  </li>
                ))}
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
    </section>
  )
}
