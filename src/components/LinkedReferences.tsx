/**
 * LinkedReferences -- shows backlinks to the current page, grouped by source page.
 *
 * Renders at the bottom of PageEditor. Groups backlinks by the page they originate
 * from, with collapsible headers for both the section and individual groups.
 * Uses cursor-based pagination with "Load more" button.
 */

import { SlidersHorizontal } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { logger } from '@/lib/logger'
import { useBacklinkResolution } from '../hooks/useBacklinkResolution'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import { useBlockPropertyEvents } from '../hooks/useBlockPropertyEvents'
import { useFocusedRowEffect } from '../hooks/useFocusedRowEffect'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import type { NavigateToPageFn } from '../lib/block-events'
import type { BacklinkFilter, BacklinkGroup, BacklinkSort } from '../lib/tauri'
import { listBacklinksGrouped, listPropertyKeys, listTagsByPrefix } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { BacklinkFilterBuilder } from './BacklinkFilterBuilder'
import { BacklinkGroupRenderer } from './BacklinkGroupRenderer'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { ListViewState } from './ListViewState'
import { LoadMoreButton } from './LoadMoreButton'
import { SourcePageFilter } from './SourcePageFilter'

const BACKLINK_FOCUS_CLASSES = ['ring-2', 'ring-ring/50', 'bg-accent/30'] as const

export interface LinkedReferencesProps {
  pageId: string
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function LinkedReferences({
  pageId,
  onNavigateToPage,
}: LinkedReferencesProps): React.ReactElement | null {
  const { t } = useTranslation()
  const { invalidationKey } = useBlockPropertyEvents()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [groups, setGroups] = useState<BacklinkGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [expanded, setExpanded] = useState(true)
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>({})
  const [filters, setFilters] = useState<BacklinkFilter[]>([])
  const [sort, setSort] = useState<BacklinkSort | null>(null)
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [sourcePageIncluded, setSourcePageIncluded] = useState<string[]>([])
  const [sourcePageExcluded, setSourcePageExcluded] = useState<string[]>([])
  const [propertyKeys, setPropertyKeys] = useState<string[]>([])
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])

  // Resolve [[ULID]] and #[ULID] tokens in block content
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName, clearCache } =
    useBacklinkResolution(groups)

  // biome-ignore lint/correctness/useExhaustiveDependencies: invalidationKey triggers refetch on property changes (F-39)
  const fetchGroups = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        // Build combined filters: advanced filters + source page filter
        const allFilters = [...filters]
        if (sourcePageIncluded.length > 0 || sourcePageExcluded.length > 0) {
          allFilters.push({
            type: 'SourcePage',
            included: sourcePageIncluded,
            excluded: sourcePageExcluded,
          })
        }

        const resp = await listBacklinksGrouped({
          blockId: pageId,
          ...(allFilters.length > 0 && { filters: allFilters }),
          ...(sort != null && { sort }),
          limit: 50,
          ...(cursor != null && { cursor }),
          spaceId: currentSpaceId,
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
          // Expand newly added groups by default
          setGroupExpanded((prev) => {
            const next = { ...prev }
            for (const newGroup of resp.groups) {
              if (!(newGroup.page_id in next)) {
                next[newGroup.page_id] = true
              }
            }
            return next
          })
        } else {
          setGroups(resp.groups)
          // Set default expand state
          const expandState: Record<string, boolean> = {}
          for (let i = 0; i < resp.groups.length; i++) {
            expandState[resp.groups[i]?.page_id as string] = resp.groups.length <= 5 || i < 3
          }
          setGroupExpanded(expandState)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(resp.total_count)
      } catch (err) {
        logger.error(
          'LinkedReferences',
          'Failed to load grouped backlinks',
          {
            pageId,
          },
          err,
        )
        toast.error(t('references.loadFailed'))
      } finally {
        setLoading(false)
      }
    },
    [
      pageId,
      filters,
      sort,
      sourcePageIncluded,
      sourcePageExcluded,
      t,
      invalidationKey,
      currentSpaceId,
    ],
  )

  // Load property keys on mount
  useEffect(() => {
    listPropertyKeys()
      .then(setPropertyKeys)
      .catch((e) => {
        logger.error('LinkedReferences', 'Failed to load property keys', undefined, e)
        toast.error(t('references.loadPropertiesFailed'))
      })
  }, [t])

  // Load tags on mount
  useEffect(() => {
    listTagsByPrefix({ prefix: '' })
      .then((result) => setTags((result ?? []).map((t) => ({ id: t.tag_id, name: t.name }))))
      .catch((e) => {
        logger.error('LinkedReferences', 'Failed to load tags', undefined, e)
        toast.error(t('references.loadTagsFailed'))
      })
  }, [t])

  // Fetch on mount and when pageId/filters change
  useEffect(() => {
    setGroups([])
    setNextCursor(null)
    setHasMore(false)
    setTotalCount(0)
    clearCache()
    fetchGroups()
  }, [fetchGroups, clearCache])

  // Reset filter state when navigating to a different page
  // Uses functional updaters to avoid no-op state updates on initial mount
  // (which would re-create fetchGroups and trigger a duplicate fetch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageId is the intentional trigger for resetting filter state on navigation
  useEffect(() => {
    setFilters((prev) => (prev.length > 0 ? [] : prev))
    setSort((prev) => (prev !== null ? null : prev))
    setSourcePageIncluded((prev) => (prev.length > 0 ? [] : prev))
    setSourcePageExcluded((prev) => (prev.length > 0 ? [] : prev))
    setShowAdvancedFilters(false)
  }, [pageId])

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev)
  }, [])

  const toggleGroup = useCallback((groupPageId: string) => {
    setGroupExpanded((prev) => ({
      ...prev,
      [groupPageId]: !prev[groupPageId],
    }))
  }, [])

  const pageTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const g of groups) {
      if (g.page_title) map.set(g.page_id, g.page_title)
    }
    return map
  }, [groups])

  const { handleBlockClick, handleBlockKeyDown } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
  })

  const loadMore = useCallback(() => {
    if (nextCursor) {
      fetchGroups(nextCursor)
    }
  }, [nextCursor, fetchGroups])

  // Flatten visible blocks for keyboard navigation
  const flatVisibleBlocks = useMemo(() => {
    const flat: { id: string; pageId: string }[] = []
    for (const g of groups) {
      if (groupExpanded[g.page_id]) {
        for (const b of g.blocks) {
          flat.push({ id: b.id, pageId: g.page_id })
        }
      }
    }
    return flat
  }, [groups, groupExpanded])

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

  useFocusedRowEffect({
    containerRef: listRef,
    focusedRowId: focusedBlockId,
    rowAttr: 'data-backlink-item',
    focusClasses: BACKLINK_FOCUS_CLASSES,
    setFocusedIndex,
    resetDeps: [groups, groupExpanded, setFocusedIndex],
  })

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (handleListKeyDown(e)) e.preventDefault()
    },
    [handleListKeyDown],
  )

  // Derive sourcePages from groups for SourcePageFilter
  const sourcePages = groups.map((g) => ({
    pageId: g.page_id,
    pageTitle: g.page_title,
    blockCount: g.blocks.length,
  }))

  const headerLabel =
    totalCount === 1 ? t('references.headerOne') : t('references.header', { count: totalCount })

  // UX-152: Don't render when no references (and not loading).
  // When filters are active, keep the panel visible so the user can
  // clear/adjust filters — otherwise the filter controls vanish.
  const hasActiveFilters =
    filters.length > 0 || sourcePageIncluded.length > 0 || sourcePageExcluded.length > 0
  if (!loading && totalCount === 0 && groups.length === 0 && !hasActiveFilters) {
    return null
  }

  return (
    <section
      className="linked-references"
      data-testid="linked-references"
      aria-label={t('references.panelLabel')}
    >
      {/* Main header -- always visible, outside ListViewState, with inline filter toggle */}
      <div className="flex flex-nowrap items-center gap-1 min-w-0">
        <CollapsiblePanelHeader
          isCollapsed={!expanded}
          onToggle={toggleExpanded}
          className="linked-references-header"
        >
          {headerLabel}
        </CollapsiblePanelHeader>
        {expanded && (totalCount > 0 || hasActiveFilters) && (
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
        {expanded && filters.length > 0 && (
          <Badge
            variant="secondary"
            className="linked-references-filter-count shrink-0 h-5 min-w-5 px-1.5 text-[10px]"
            aria-label={t('references.filtersAppliedAriaLabel', { count: filters.length })}
          >
            {t('references.filtersAppliedBadge', { count: filters.length })}
          </Badge>
        )}
      </div>

      {expanded && (
        <ListViewState
          loading={loading}
          items={groups}
          skeleton={
            <LoadingSkeleton
              count={3}
              height="h-12"
              className="linked-references-loading"
              aria-busy="true"
              role="status"
            />
          }
          empty={null}
        >
          {() => (
            <div className="linked-references-content mt-1 space-y-2">
              {/* Filter controls */}
              <div className="linked-references-filters flex flex-col sm:flex-row sm:items-center gap-2 px-2">
                <SourcePageFilter
                  sourcePages={sourcePages}
                  included={sourcePageIncluded}
                  excluded={sourcePageExcluded}
                  onChange={(inc, exc) => {
                    setSourcePageIncluded(inc)
                    setSourcePageExcluded(exc)
                  }}
                />
              </div>

              {showAdvancedFilters && (
                <div className="linked-references-advanced-filters px-2">
                  <BacklinkFilterBuilder
                    filters={filters}
                    sort={sort}
                    onFiltersChange={setFilters}
                    onSortChange={setSort}
                    totalCount={totalCount}
                    filteredCount={totalCount}
                    propertyKeys={propertyKeys}
                    tags={tags}
                    tagResolver={resolveTagName}
                  />
                </div>
              )}

              {/* biome-ignore lint/a11y/useSemanticElements: keyboard nav container wrapping BacklinkGroupRenderer */}
              <div
                ref={listRef}
                role="group"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard nav requires focusable container
                tabIndex={0}
                onKeyDown={handleContainerKeyDown}
                aria-label={t('linkedRefs.listLabel')}
                className="linked-references-list outline-none"
              >
                <BacklinkGroupRenderer
                  groups={groups}
                  expandedGroups={groupExpanded}
                  onToggleGroup={toggleGroup}
                  onNavigateToPage={onNavigateToPage}
                  handleBlockClick={handleBlockClick}
                  handleBlockKeyDown={handleBlockKeyDown}
                  resolveBlockTitle={resolveBlockTitle}
                  resolveBlockStatus={resolveBlockStatus}
                  resolveTagName={resolveTagName}
                  linkType="linked"
                />
              </div>

              <LoadMoreButton
                hasMore={hasMore}
                loading={loading}
                onLoadMore={loadMore}
                className="linked-references-load-more"
                label={t('references.loadMore')}
                loadingLabel={t('references.loading')}
                ariaLabel={t('references.loadMoreLabel')}
                ariaLoadingLabel={t('references.loadingMore')}
                loadedCount={groups.reduce((sum, g) => sum + g.blocks.length, 0)}
                totalCount={totalCount}
              />
            </div>
          )}
        </ListViewState>
      )}
    </section>
  )
}
