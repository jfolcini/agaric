/**
 * LinkedReferences -- shows backlinks to the current page, grouped by source page.
 *
 * Renders at the bottom of PageEditor. Groups backlinks by the page they originate
 * from, with collapsible headers for both the section and individual groups.
 * Uses cursor-based pagination with "Load more" button.
 */

import { Link2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'
import { useBacklinkResolution } from '../hooks/useBacklinkResolution'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import type { NavigateToPageFn } from '../lib/block-events'
import type { BacklinkFilter, BacklinkGroup, BacklinkSort } from '../lib/tauri'
import { listBacklinksGrouped, listPropertyKeys, listTagsByPrefix } from '../lib/tauri'
import { BacklinkFilterBuilder } from './BacklinkFilterBuilder'
import { BacklinkGroupRenderer } from './BacklinkGroupRenderer'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { EmptyState } from './EmptyState'
import { ListViewState } from './ListViewState'
import { LoadMoreButton } from './LoadMoreButton'
import { SourcePageFilter } from './SourcePageFilter'

export interface LinkedReferencesProps {
  pageId: string
  onNavigateToPage?: NavigateToPageFn | undefined
}

export function LinkedReferences({
  pageId,
  onNavigateToPage,
}: LinkedReferencesProps): React.ReactElement | null {
  const { t } = useTranslation()
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

  // Fetch grouped backlinks
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
          pageId,
          ...(allFilters.length > 0 && { filters: allFilters }),
          ...(sort != null && { sort }),
          limit: 50,
          ...(cursor != null && { cursor }),
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
    [pageId, filters, sort, sourcePageIncluded, sourcePageExcluded, t],
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

  // Derive sourcePages from groups for SourcePageFilter
  const sourcePages = groups.map((g) => ({
    pageId: g.page_id,
    pageTitle: g.page_title,
    blockCount: g.blocks.length,
  }))

  const headerLabel =
    totalCount === 1 ? t('references.headerOne') : t('references.header', { count: totalCount })

  return (
    <section className="linked-references" aria-label={t('references.panelLabel')}>
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
        empty={<EmptyState icon={Link2} message={t('references.noReferences')} compact />}
      >
        {() => (
          <>
            {/* Main header -- collapsible */}
            <CollapsiblePanelHeader
              isCollapsed={!expanded}
              onToggle={toggleExpanded}
              className="linked-references-header"
            >
              {headerLabel}
            </CollapsiblePanelHeader>

            {expanded && (
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground"
                    onClick={() => setShowAdvancedFilters((prev) => !prev)}
                    aria-expanded={showAdvancedFilters}
                  >
                    {showAdvancedFilters
                      ? t('references.hideFilters')
                      : t('references.moreFilters')}
                  </Button>
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
                />

                <LoadMoreButton
                  hasMore={hasMore}
                  loading={loading}
                  onLoadMore={loadMore}
                  className="linked-references-load-more"
                  label={t('references.loadMore')}
                  loadingLabel={t('references.loading')}
                  ariaLabel={t('references.loadMoreLabel')}
                  ariaLoadingLabel={t('references.loadingMore')}
                />
              </div>
            )}
          </>
        )}
      </ListViewState>
    </section>
  )
}
