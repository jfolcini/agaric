/**
 * UnlinkedReferences — shows blocks that mention the page title text
 * without a [[link]], grouped by source page.
 *
 * Collapsed by default. Each block result has a "Link it" button that
 * converts the first plain-text mention into a [[pageId]] link.
 */

import { Link2, Loader2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { BacklinkGroup } from '../lib/tauri'
import { editBlock, listUnlinkedReferences } from '../lib/tauri'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import type { NavigateToPageFn } from '../lib/block-events'
import { CollapsibleGroupList } from './CollapsibleGroupList'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'

export interface UnlinkedReferencesProps {
  pageId: string
  pageTitle: string
  onNavigateToPage?: NavigateToPageFn | undefined
}

/** Escape special regex characters so a literal string can be used in `new RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function UnlinkedReferences({
  pageId,
  pageTitle,
  onNavigateToPage,
}: UnlinkedReferencesProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<BacklinkGroup[]>([])
  const [collapsed, setCollapsed] = useState(true)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)

  const fetchGroups = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        const resp = await listUnlinkedReferences({
          pageId,
          cursor: cursor ?? null,
          limit: 20,
        })
        if (cursor) {
          // Append: merge groups with same page_id
          setGroups((prev) => {
            const merged = [...prev]
            for (const newGroup of resp.groups) {
              const existing = merged.find((g) => g.page_id === newGroup.page_id)
              if (existing) {
                existing.blocks = [...existing.blocks, ...newGroup.blocks]
              } else {
                merged.push(newGroup)
              }
            }
            return merged
          })
        } else {
          setGroups(resp.groups)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(resp.total_count)
      } catch {
        toast.error(t('unlinkedRefs.loadFailed'))
      } finally {
        setLoading(false)
      }
    },
    [pageId, t],
  )

  // Fetch on expand or when pageId changes — lazy load
  useEffect(() => {
    setGroups([])
    setNextCursor(null)
    setHasMore(false)
    setTotalCount(0)
    setExpandedGroups({})
    if (!collapsed) {
      fetchGroups()
    }
  }, [fetchGroups, collapsed])

  // Reset collapsed state when pageId changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageId is the intentional trigger for resetting collapse state on navigation
  useEffect(() => {
    setCollapsed(true)
  }, [pageId])

  const handleLinkIt = useCallback(
    async (blockId: string, content: string) => {
      const regex = new RegExp(escapeRegExp(pageTitle), 'i')
      const newContent = content.replace(regex, `[[${pageId}]]`)
      try {
        await editBlock(blockId, newContent)
        // Remove block from groups after successful edit
        setGroups((prev) =>
          prev
            .map((g) => ({
              ...g,
              blocks: g.blocks.filter((b) => b.id !== blockId),
            }))
            .filter((g) => g.blocks.length > 0),
        )
        setTotalCount((prev) => prev - 1)
      } catch {
        toast.error(t('unlinkedRefs.linkFailed'))
      }
    },
    [pageId, pageTitle, t],
  )

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  const toggleGroup = useCallback((groupPageId: string) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [groupPageId]: !(prev[groupPageId] ?? true),
    }))
  }, [])

  const loadMore = useCallback(() => {
    if (nextCursor) {
      fetchGroups(nextCursor)
    }
  }, [nextCursor, fetchGroups])

  const pageTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const g of groups) {
      if (g.page_title) map.set(g.page_id, g.page_title)
    }
    return map
  }, [groups])

  const { handleBlockClick } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: t('unlinkedRefs.untitled'),
  })

  const headerLabel =
    totalCount === 0
      ? t('unlinkedRefs.headerNone')
      : totalCount === 1
        ? t('unlinkedRefs.headerOne')
        : t('unlinkedRefs.header', { count: totalCount })

  return (
    <section className="unlinked-references" aria-label="Unlinked references">
      {/* Main header — collapsible, collapsed by default */}
      <CollapsiblePanelHeader
        collapsed={collapsed}
        onToggle={toggleCollapsed}
        className="unlinked-references-header"
      >
        {headerLabel}
      </CollapsiblePanelHeader>

      {!collapsed && (
        <div className="unlinked-references-content mt-1 space-y-2">
          {/* Loading state */}
          {loading && groups.length === 0 && (
            <div
              className="unlinked-references-loading flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
              aria-busy="true"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" /> {t('unlinkedRefs.loading')}
            </div>
          )}

          {/* Empty state */}
          {!loading && totalCount === 0 && groups.length === 0 && (
            <EmptyState compact message={t('unlinkedRefs.noResults')} />
          )}

          {/* Group list */}
          <CollapsibleGroupList
            groups={groups}
            expandedGroups={expandedGroups}
            onToggleGroup={toggleGroup}
            untitledLabel={t('unlinkedRefs.untitled')}
            defaultExpanded
            groupClassName="unlinked-references-group"
            headerClassName="unlinked-references-group-header flex w-full items-center gap-2 rounded-md px-3 py-1 text-sm font-medium hover:bg-accent/50 transition-colors"
            listClassName="unlinked-references-blocks ml-4 mt-1 space-y-1"
            listAriaLabel={(title) => t('unlinkedRefs.mentionsFrom', { title })}
            {...(onNavigateToPage && {
              onPageTitleClick: (pageId: string, title: string) => onNavigateToPage(pageId, title),
            })}
            renderBlock={(block, _group) => (
              <li
                key={block.id}
                className="unlinked-reference-item flex items-center gap-3 border-b py-1.5 px-2 last:border-b-0"
              >
                <button
                  type="button"
                  className="unlinked-reference-item-text text-sm flex-1 truncate cursor-pointer hover:bg-muted/50 text-left"
                  onClick={() => handleBlockClick(block)}
                >
                  {block.content || t('unlinkedRefs.empty')}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="link-it-button shrink-0 text-xs text-muted-foreground hover:text-primary"
                  onClick={() => handleLinkIt(block.id, block.content ?? '')}
                  aria-label={`Link it: replace mention in block ${block.id.slice(0, 8)}`}
                >
                  <Link2 className="h-3.5 w-3.5 mr-1" />
                  {t('unlinkedRefs.linkIt')}
                </Button>
              </li>
            )}
          />

          {/* Load more pagination */}
          <LoadMoreButton
            hasMore={hasMore}
            loading={loading}
            onLoadMore={loadMore}
            className="unlinked-references-load-more"
            label={t('unlinkedRefs.loadMore')}
            loadingLabel={t('unlinkedRefs.loadingDots')}
            ariaLabel={t('unlinkedRefs.loadMoreLabel')}
            ariaLoadingLabel={t('unlinkedRefs.loadingMore')}
          />
        </div>
      )}
    </section>
  )
}
