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
import { useBacklinkGroups } from '@/hooks/useBacklinkGroups'
import { useBacklinkResolution } from '@/hooks/useBacklinkResolution'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useFocusedRowEffect } from '@/hooks/useFocusedRowEffect'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { usePropertyKeysCache } from '@/hooks/usePropertyKeysCache'
import type { NavigateToPageFn } from '@/lib/block-events'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { BacklinkFilter, BacklinkSort } from '@/lib/tauri'
import { listTagsByPrefix } from '@/lib/tauri'
import { useSpaceStore } from '@/stores/space'

const BACKLINK_FOCUS_CLASSES = ['ring-2', 'ring-inset', 'ring-ring/50', 'bg-accent/30'] as const

/** Stable, unique DOM id for a linked-reference row (aria-activedescendant target). */
function linkedRowDomId(blockId: string): string {
  return `linked-ref-row-${blockId}`
}

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
  const [expanded, setExpanded] = useState(true)
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>({})
  const [filters, setFilters] = useState<BacklinkFilter[]>([])
  const [sort, setSort] = useState<BacklinkSort | null>(null)
  const [sourcePageIncluded, setSourcePageIncluded] = useState<string[]>([])
  const [sourcePageExcluded, setSourcePageExcluded] = useState<string[]>([])
  // Shared cache replaces per-mount `listPropertyKeys()` IPC.
  const propertyKeys = usePropertyKeysCache(currentSpaceId)
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])

  // #2597 — the hand-rolled `fetchGroups` cursor state machine is now a
  // TanStack `useInfiniteQuery` (see `useBacklinkGroups`). TanStack owns the
  // page list, cursor, loading and error state; `invalidationKey` sits in the
  // query key so a property-change event refetches (F-39).
  const { groups, totalCount, loading, hasMore, isFetchingMore, loadMore, isError } =
    useBacklinkGroups({
      pageId,
      filters,
      sort,
      sourcePageIncluded,
      sourcePageExcluded,
      spaceId: currentSpaceId,
      invalidationKey,
    })

  // Resolve [[ULID]] and #[ULID] tokens in block content
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName, clearCache } =
    useBacklinkResolution(groups)

  // Error toast parity: the old `fetchGroups` catch surfaced a single deduped
  // toast on any fetch failure (initial OR load-more). The `{ id }` coalesces
  // repeats. The observability `logger.error` now lives in the hook's queryFn.
  useEffect(() => {
    if (isError) {
      notify.error(t('references.loadFailed'), { id: 'references-load-failed' })
    }
  }, [isError, t])

  // Expand-state seeding parity. The old first-page branch REPLACED
  // `groupExpanded` with `page_id => groups.length <= 5 || i < 3` (first 3 groups
  // expanded, or ALL if ≤5); the append branch defaulted only newly-appearing
  // `page_id`s to expanded without clobbering existing (user) toggles. A ref
  // tracks the current query's identity: when it changes, the next non-empty
  // `groups` is a fresh first page and re-seeds; growth within the same query is
  // an append.
  const queryIdentity = useMemo(
    () =>
      JSON.stringify([
        currentSpaceId,
        pageId,
        invalidationKey,
        filters,
        sort,
        sourcePageIncluded,
        sourcePageExcluded,
      ]),
    [
      currentSpaceId,
      pageId,
      invalidationKey,
      filters,
      sort,
      sourcePageIncluded,
      sourcePageExcluded,
    ],
  )
  const seededIdentityRef = useRef<string | null>(null)
  useEffect(() => {
    if (groups.length === 0) return
    if (seededIdentityRef.current !== queryIdentity) {
      // Fresh first page: replace expand state with the ≤5 || i<3 rule.
      const expandState: Record<string, boolean> = {}
      for (let i = 0; i < groups.length; i++) {
        expandState[groups[i]?.page_id as string] = groups.length <= 5 || i < 3
      }
      setGroupExpanded(expandState)
      seededIdentityRef.current = queryIdentity
    } else {
      // Load-more append: default newly-appearing groups to expanded, never
      // overwriting an already-present `page_id` (preserves user toggles).
      setGroupExpanded((prev) => {
        let changed = false
        const next = { ...prev }
        for (const g of groups) {
          if (!(g.page_id in next)) {
            next[g.page_id] = true
            changed = true
          }
        }
        return changed ? next : prev
      })
    }
  }, [groups, queryIdentity])

  // Clear the resolution cache on every fetch-identity change so stale resolved
  // `[[ULID]]`/`#[ULID]` titles don't leak across pages OR survive a property
  // change that renamed a linked target. The pre-migration load effect ran
  // `clearCache()` before each refetch, and its `fetchGroups` dep set was
  // exactly this identity (space/page/invalidationKey/filters/sort/sourcePage) —
  // so keying on `queryIdentity` preserves that: an `invalidationKey` bump
  // (F-39) re-resolves titles, matching old behaviour, rather than letting a
  // renamed target stay stale for the 5-minute resolution TTL. `clearCache` is
  // stable (useCallback []).
  useEffect(() => {
    clearCache()
  }, [queryIdentity, clearCache])

  // Load tags on mount (B-6: cancellation flag avoids React 19
  // strict-mode "state update on unmounted component" warnings on rapid
  // mount/unmount).
  useEffect(() => {
    let cancelled = false
    listTagsByPrefix({ prefix: '' })
      .then((result) => {
        if (cancelled) return
        setTags((result ?? []).map((tag) => ({ id: tag.tag_id, name: tag.name })))
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

  // Reset filter state when navigating to a different page
  // Uses functional updaters to avoid no-op state updates on initial mount
  // (which would needlessly change the query key and trigger a duplicate fetch).
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
                // #2263 — expose the roving keyboard position to AT. The
                // grouped, collapsible structure (interleaved group-header
                // buttons) rules out the listbox/option model, so we use the
                // APG composite alternative: aria-activedescendant on the
                // focusable container + aria-current on the active row.
                aria-activedescendant={focusedBlockId ? linkedRowDomId(focusedBlockId) : undefined}
                className="linked-references-list focus-ring-visible"
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
                  focusedBlockId={focusedBlockId}
                  rowDomId={linkedRowDomId}
                />
              </div>

              <LoadMoreButton
                hasMore={hasMore}
                loading={isFetchingMore}
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
