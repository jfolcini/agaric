/**
 * UnlinkedReferences — shows blocks that mention the page title text
 * without a [[link]], grouped by source page.
 *
 * Collapsed by default. Each block result has a "Link it" button that
 * converts the first plain-text mention into a [[pageId]] link.
 */

import { Link2, SlidersHorizontal } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { logger } from '@/lib/logger'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import type { NavigateToPageFn } from '../lib/block-events'
import type { BacklinkFilter, BacklinkGroup, BacklinkSort } from '../lib/tauri'
import { editBlock, listPropertyKeys, listTagsByPrefix, listUnlinkedReferences } from '../lib/tauri'
import { BacklinkFilterBuilder } from './BacklinkFilterBuilder'
import { CollapsibleGroupList } from './CollapsibleGroupList'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { EmptyState } from './EmptyState'
import { ListViewState } from './ListViewState'
import { LoadMoreButton } from './LoadMoreButton'

const UNLINKED_FOCUS_CLASSES = 'ring-2 ring-ring/50 bg-accent/30'

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
  const [filters, setFilters] = useState<BacklinkFilter[]>([])
  const [sort, setSort] = useState<BacklinkSort | null>(null)
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [propertyKeys, setPropertyKeys] = useState<string[]>([])
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])

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
      } catch (err) {
        logger.error('UnlinkedReferences', 'Failed to load unlinked references', { pageId }, err)
        toast.error(t('unlinkedRefs.loadFailed'))
      } finally {
        setLoading(false)
      }
    },
    [pageId, t],
  )

  // Fetch on mount and when pageId changes (eager — needed to know if we
  // should render the panel at all, see UX-152 early-return below).
  useEffect(() => {
    setGroups([])
    setNextCursor(null)
    setHasMore(false)
    setTotalCount(0)
    setExpandedGroups({})
    fetchGroups()
  }, [fetchGroups])

  // Reset collapsed state when pageId changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageId is the intentional trigger for resetting collapse state on navigation
  useEffect(() => {
    setCollapsed(true)
    setShowAdvancedFilters(false)
  }, [pageId])

  // Load tags on mount
  useEffect(() => {
    listTagsByPrefix({ prefix: '' })
      .then((result) => setTags((result ?? []).map((t) => ({ id: t.tag_id, name: t.name }))))
      .catch((e) => {
        logger.error('UnlinkedReferences', 'Failed to load tags', undefined, e)
      })
  }, [])

  // Load property keys on mount
  useEffect(() => {
    listPropertyKeys()
      .then((keys) => setPropertyKeys(keys))
      .catch((e) => {
        logger.error('UnlinkedReferences', 'Failed to load property keys', undefined, e)
      })
  }, [])

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
      } catch (err) {
        logger.error('UnlinkedReferences', 'Failed to link block to page', { blockId, pageId }, err)
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

  // Flatten visible blocks for keyboard navigation
  const flatVisibleBlocks = useMemo(() => {
    const flat: { id: string; pageId: string }[] = []
    for (const g of groups) {
      if (expandedGroups[g.page_id] ?? true) {
        for (const b of g.blocks) {
          flat.push({ id: b.id, pageId: g.page_id })
        }
      }
    }
    return flat
  }, [groups, expandedGroups])

  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: handleListKeyDown,
  } = useListKeyboardNavigation({
    itemCount: flatVisibleBlocks.length,
    onSelect: (idx) => {
      const entry = flatVisibleBlocks[idx]
      if (!entry) return
      const group = groups.find((g) => g.page_id === entry.pageId)
      const block = group?.blocks.find((b) => b.id === entry.id)
      if (block) handleBlockClick(block)
    },
  })

  const listRef = useRef<HTMLDivElement>(null)

  const focusedBlockId = flatVisibleBlocks[focusedIndex]?.id ?? null

  // Reset focusedIndex when groups change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    setFocusedIndex(0)
  }, [groups, expandedGroups, setFocusedIndex])

  // Scroll focused block into view and apply focus indicator
  useEffect(() => {
    const container = listRef.current
    if (!container || !focusedBlockId) return

    const el = container.querySelector(`[data-backlink-item="${focusedBlockId}"]`) as HTMLElement
    if (!el) return

    el.scrollIntoView({ block: 'nearest' })

    // Apply focus classes
    const classes = UNLINKED_FOCUS_CLASSES.split(' ')
    for (const cls of classes) el.classList.add(cls)
    return () => {
      for (const cls of classes) el.classList.remove(cls)
    }
  }, [focusedBlockId])

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (handleListKeyDown(e)) e.preventDefault()
    },
    [handleListKeyDown],
  )

  const headerLabel =
    totalCount === 0
      ? t('unlinkedRefs.headerNone')
      : totalCount === 1
        ? t('unlinkedRefs.headerOne')
        : t('unlinkedRefs.header', { count: totalCount })

  // UX-152: Don't render when no unlinked references (and not loading).
  // When filters are active, keep the panel visible so the user can
  // clear/adjust filters — otherwise the filter controls vanish.
  if (!loading && totalCount === 0 && groups.length === 0 && filters.length === 0) {
    return null
  }

  return (
    <section className="unlinked-references" aria-label={t('unlinkedRefs.panelLabel')}>
      {/* Main header — collapsible, collapsed by default, with inline filter toggle */}
      <div className="flex items-center gap-1">
        <CollapsiblePanelHeader
          isCollapsed={collapsed}
          onToggle={toggleCollapsed}
          className="unlinked-references-header"
        >
          {headerLabel}
        </CollapsiblePanelHeader>
        {!collapsed && totalCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-7 w-7 text-muted-foreground"
                onClick={() => setShowAdvancedFilters((prev) => !prev)}
                aria-expanded={showAdvancedFilters}
                aria-label={
                  showAdvancedFilters ? t('references.hideFilters') : t('references.showFilters')
                }
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showAdvancedFilters ? t('references.hideFilters') : t('references.showFilters')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {showAdvancedFilters && !collapsed && (
        <div className="unlinked-references-advanced-filters px-2">
          <BacklinkFilterBuilder
            filters={filters}
            sort={sort}
            onFiltersChange={setFilters}
            onSortChange={setSort}
            totalCount={totalCount}
            filteredCount={totalCount}
            propertyKeys={propertyKeys}
            tags={tags}
          />
        </div>
      )}

      {!collapsed && (
        <div className="unlinked-references-content mt-1 space-y-2">
          <ListViewState
            loading={loading}
            items={groups}
            skeleton={
              <div
                className="unlinked-references-loading flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
                aria-busy="true"
                role="status"
              >
                <Spinner /> {t('unlinkedRefs.loading')}
              </div>
            }
            empty={<EmptyState compact message={t('unlinkedRefs.noResults')} />}
          >
            {() => (
              <>
                {/* Group list */}
                {/* biome-ignore lint/a11y/useSemanticElements: keyboard nav container wrapping BacklinkGroupRenderer */}
                <div
                  ref={listRef}
                  role="group"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard nav requires focusable container
                  tabIndex={0}
                  onKeyDown={handleContainerKeyDown}
                  aria-label="Unlinked reference blocks"
                  className="unlinked-references-list outline-none"
                >
                  <CollapsibleGroupList
                    groups={groups}
                    expandedGroups={expandedGroups}
                    onToggleGroup={toggleGroup}
                    untitledLabel={t('unlinkedRefs.untitled')}
                    defaultExpanded
                    groupClassName="unlinked-references-group"
                    headerClassName="unlinked-references-group-header flex w-full items-center gap-2 rounded-md px-3 py-1 text-sm font-medium hover:bg-accent/50 active:bg-accent/70 transition-colors"
                    listClassName="unlinked-references-blocks ml-4 mt-1 space-y-1"
                    listAriaLabel={(title) => t('unlinkedRefs.mentionsFrom', { title })}
                    {...(onNavigateToPage && {
                      onPageTitleClick: (pageId: string, title: string) =>
                        onNavigateToPage(pageId, title),
                    })}
                    renderBlock={(block, _group) => (
                      <li
                        key={block.id}
                        data-backlink-item={block.id}
                        className={`unlinked-reference-item flex items-center gap-3 border-b py-1.5 px-2 last:border-b-0${block.id === focusedBlockId ? ` ${UNLINKED_FOCUS_CLASSES}` : ''}`}
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
                </div>

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
              </>
            )}
          </ListViewState>
        </div>
      )}
    </section>
  )
}
