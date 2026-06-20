/**
 * LinkedReferences -- shows backlinks to the current page, grouped by source page.
 *
 * Renders at the bottom of PageEditor. Groups backlinks by the page they originate
 * from, with collapsible headers for both the section and individual groups.
 * Uses cursor-based pagination with a `t('references.loadMore')` button.
 */

import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BacklinkFilterBuilder } from '@/components/BacklinkFilterBuilder'
import { BacklinkGroupRenderer } from '@/components/backlinks/BacklinkGroupRenderer'
import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { SourcePageFilter } from '@/components/filters/SourcePageFilter'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { useBacklinkResolution } from '@/hooks/useBacklinkResolution'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useFocusedRowEffect } from '@/hooks/useFocusedRowEffect'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { usePropertyKeysCache } from '@/hooks/usePropertyKeysCache'
import type { NavigateToPageFn } from '@/lib/block-events'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { BacklinkFilter, BacklinkGroup, BacklinkSort } from '@/lib/tauri'
import { listBacklinksGrouped, listTagsByPrefix } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

const BACKLINK_FOCUS_CLASSES = ['ring-2', 'ring-inset', 'ring-ring/50', 'bg-accent/30'] as const

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
  const [sourcePageIncluded, setSourcePageIncluded] = useState<string[]>([])
  const [sourcePageExcluded, setSourcePageExcluded] = useState<string[]>([])
  // Shared cache replaces per-mount `listPropertyKeys()` IPC.
  const propertyKeys = usePropertyKeysCache(currentSpaceId)
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])

  // Resolve [[ULID]] and #[ULID] tokens in block content
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName, clearCache } =
    useBacklinkResolution(groups)

  // invalidationKey is intentionally in the dep array even though the body
  // doesn't read it: bumping it rebuilds `fetchGroups`, which the load effect
  // depends on, forcing a refetch when block properties change (F-39).
  /* oxlint-disable react-hooks/exhaustive-deps -- invalidationKey intentionally rebuilds fetchGroups to refetch on property changes (F-39); see comment above. */
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
          limit: PAGINATION_LIMIT,
          ...(cursor != null && { cursor }),
          spaceId: currentSpaceId,
        })
        if (cursor) {
          // Append: merge groups with same page_id (Map<page_id, group>
          // avoids the O(N×M) `.find()` per new group).
          setGroups((prev) => {
            const byPageId = new Map(prev.map((g) => [g.page_id, g]))
            for (const newGroup of resp.groups) {
              const existing = byPageId.get(newGroup.page_id)
              if (existing) {
                // Construct a fresh group object instead of mutating the
                // prior-state object (#1529): in-place `existing.blocks = ...`
                // violates React's immutable-state contract and is a latent
                // footgun once a memoized child / equality check is added.
                byPageId.set(newGroup.page_id, {
                  ...existing,
                  blocks: [...existing.blocks, ...newGroup.blocks],
                })
              } else {
                byPageId.set(newGroup.page_id, newGroup)
              }
            }
            return Array.from(byPageId.values())
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
        notify.error(t('references.loadFailed'), { id: 'references-load-failed' })
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
  /* oxlint-enable react-hooks/exhaustive-deps */

  // Load tags on mount (B-6: cancellation flag avoids React 19
  // strict-mode "state update on unmounted component" warnings on rapid
  // mount/unmount).
  useEffect(() => {
    let cancelled = false
    listTagsByPrefix({ prefix: '' })
      .then((result) => {
        if (cancelled) return
        setTags((result ?? []).map((t) => ({ id: t.tag_id, name: t.name })))
      })
      .catch((e) => {
        if (cancelled) return
        logger.error('LinkedReferences', 'Failed to load tags', undefined, e)
        notify.error(t('references.loadTagsFailed'), { id: 'references-load-tags-failed' })
      })
    return () => {
      cancelled = true
    }
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
  useEffect(() => {
    setFilters((prev) => (prev.length > 0 ? [] : prev))
    setSort((prev) => (prev !== null ? null : prev))
    setSourcePageIncluded((prev) => (prev.length > 0 ? [] : prev))
    setSourcePageExcluded((prev) => (prev.length > 0 ? [] : prev))
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

  // Derive sourcePages from groups for SourcePageFilter.
  // Memoized on [groups] (matching pageTitles above) so its identity is stable
  // across focus-driven re-renders (focusedIndex is state; useFocusedRowEffect
  // fires on keyboard navigation) -- avoids rebuilding this array each focus move.
  const sourcePages = useMemo(
    () =>
      groups.map((g) => ({
        pageId: g.page_id,
        pageTitle: g.page_title,
        blockCount: g.blocks.length,
      })),
    [groups],
  )

  const headerLabel =
    totalCount === 1 ? t('references.headerOne') : t('references.header', { count: totalCount })

  // Render nothing when there are no backlinks (and not loading): an empty
  // "no backlinks yet" panel is clutter at the bottom of every page. This
  // Intentionally overrides the older empty-state mandate for this
  // panel (user decision, live UX review). When filters are active, keep the
  // full panel visible so the user can clear/adjust filters — otherwise the
  // filter controls vanish. The loading branch below still renders so nothing
  // flashes mid-fetch.
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
      {/* Main header -- always visible, outside ListViewState, with inline source-page filter */}
      <div className="flex flex-nowrap items-center gap-1 min-w-0">
        <CollapsiblePanelHeader
          isCollapsed={!expanded}
          onToggle={toggleExpanded}
          className="linked-references-header"
        >
          {headerLabel}
        </CollapsiblePanelHeader>
        {expanded && (totalCount > 0 || hasActiveFilters) && (
          <SourcePageFilter
            sourcePages={sourcePages}
            included={sourcePageIncluded}
            excluded={sourcePageExcluded}
            onChange={(inc, exc) => {
              setSourcePageIncluded(inc)
              setSourcePageExcluded(exc)
            }}
          />
        )}
        {expanded && filters.length > 0 && (
          <Badge
            tone="secondary"
            className="linked-references-filter-count shrink-0 h-5 min-w-5 px-1.5 text-xs"
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
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role is a prop forwarded to the <LoadingSkeleton> component, not a DOM element; no native tag applies here
              role="status"
            />
          }
          empty={null}
        >
          {() => (
            <div className="linked-references-content mt-1 space-y-2">
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

              {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- focusable group implements roving keyboard navigation over reference rows; keydown delegation belongs on the container */}
              <div
                ref={listRef}
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- focusable container implementing roving keyboard navigation over reference rows; <fieldset>/<optgroup> etc. add form/list semantics and break the layout
                role="group"
                // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard nav requires focusable container
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
