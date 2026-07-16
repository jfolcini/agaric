/**
 * UnlinkedReferences — shows blocks that mention the page title text
 * without a [[link]], grouped by source page.
 *
 * Collapsed by default. Each block result has a `t('unlinkedRefs.linkIt')` button that
 * converts the first plain-text mention into a [[pageId]] link.
 */

import type { InfiniteData } from '@tanstack/react-query'
import { Link2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BacklinkFilterBuilder } from '@/components/BacklinkFilterBuilder'
import { CollapsibleGroupList } from '@/components/common/CollapsibleGroupList'
import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useFocusedRowEffect } from '@/hooks/useFocusedRowEffect'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { usePropertyKeysCache } from '@/hooks/usePropertyKeysCache'
import { useUnlinkedReferences } from '@/hooks/useUnlinkedReferences'
import type { NavigateToPageFn } from '@/lib/block-events'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { queryClient } from '@/lib/query-client'
import type {
  BacklinkFilter,
  BacklinkGroup,
  BacklinkSort,
  GroupedBacklinkResponse,
} from '@/lib/tauri'
import { editBlock, getPageAliases, listTagsByPrefix } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const UNLINKED_FOCUS_CLASSES = 'ring-2 ring-inset ring-ring/50 bg-accent/30'
const UNLINKED_FOCUS_CLASSES_ARR = UNLINKED_FOCUS_CLASSES.split(' ')

/** Stable, unique DOM id for an unlinked-reference row (aria-activedescendant target). */
function unlinkedRowDomId(blockId: string): string {
  return `unlinked-ref-row-${blockId}`
}

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
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [collapsed, setCollapsed] = useState(true)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [filters, setFilters] = useState<BacklinkFilter[]>([])
  const [sort, setSort] = useState<BacklinkSort | null>(null)
  // `eval_unlinked_references` (backend) OR-joins title +
  // aliases into the FTS query, so a block that mentions ONLY an alias
  // surfaces here. The FE-side `handleLinkIt` then needs to know the
  // same alias set to perform the literal-text rewrite, otherwise the
  // regex compiled from `pageTitle` alone misses and the user is told
  // "linked" while the block silently reappears on the next refetch.
  const [aliases, setAliases] = useState<string[]>([])
  // Shared cache replaces per-mount `listPropertyKeys()` IPC.
  const propertyKeys = usePropertyKeysCache(currentSpaceId)
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])

  // #2597 — the hand-rolled `fetchGroups` cursor state machine is now a
  // TanStack `useInfiniteQuery` (see `useUnlinkedReferences`). TanStack owns the
  // page list, cursor, loading and error state; this is a read-only surface with
  // no `invalidationKey` (the old `fetchGroups` never watched property events).
  const {
    groups,
    totalCount,
    truncated,
    loading,
    hasMore,
    isFetchingMore,
    loadMore,
    isError,
    queryKey,
  } = useUnlinkedReferences({ pageId, filters, sort, spaceId: currentSpaceId })

  // Bug 2 — pre-warm the resolve cache for source-page IDs. Without this,
  // `useBlockResolve.resolveTitle` falls back to the `[[ULID-prefix...]]`
  // placeholder for any source page that hasn't been visited yet (e.g. a deeply
  // nested child created in another session). The matched-block content path
  // already benefits from `useBacklinkResolution` warming, but the
  // source-page-header path surfaces these IDs directly and needs its own
  // pre-warm. Keyed on the derived `groups` — re-warms whenever a fetch (initial
  // or load-more) changes the merged group list, mirroring the old per-fetch
  // `batchSet` in `fetchGroups`.
  useEffect(() => {
    const resolveEntries = groups
      .filter((g) => g.page_title != null && g.page_title.length > 0)
      .map((g) => ({
        id: g.page_id,
        title: g.page_title as string,
        deleted: false,
      }))
    if (resolveEntries.length > 0) {
      useResolveStore.getState().batchSet(resolveEntries)
    }
  }, [groups])

  // Error toast parity: the old `fetchGroups` catch surfaced a single deduped
  // toast on any fetch failure. The `{ id }` coalesces repeats. The
  // observability `logger.error` now lives in the hook's queryFn.
  useEffect(() => {
    if (isError) {
      notify.error(t('unlinkedRefs.loadFailed'), { id: 'unlinked-refs-load-failed' })
    }
  }, [isError, t])

  // Reset per-group expand state when the query identity changes. The old load
  // effect did `setExpandedGroups({})` on pageId/query change. Groups default to
  // expanded (`expandedGroups[page_id] ?? true` + `CollapsibleGroupList
  // defaultExpanded`), so there is no ≤5/i<3 seeding — just clear overrides.
  const queryIdentity = useMemo(
    () => JSON.stringify([currentSpaceId, pageId, filters, sort]),
    [currentSpaceId, pageId, filters, sort],
  )
  useEffect(() => {
    setExpandedGroups({})
  }, [queryIdentity])

  // Reset collapsed state when pageId changes
  useEffect(() => {
    setCollapsed(true)
  }, [pageId])

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
        logger.error('UnlinkedReferences', 'Failed to load tags', undefined, e)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Load the page's aliases alongside the title so
  // `handleLinkIt` can rewrite alias-only mentions. Mirrors the
  // `getPageAliases(pageId)` pattern already used by `PageHeader`.
  useEffect(() => {
    let cancelled = false
    getPageAliases(pageId)
      .then((rows) => {
        if (cancelled) return
        setAliases(rows ?? [])
      })
      .catch((err) => {
        if (cancelled) return
        logger.error('UnlinkedReferences', 'Failed to load aliases', { pageId }, err)
      })
    return () => {
      cancelled = true
    }
  }, [pageId])

  const handleLinkIt = useCallback(
    async (blockId: string, content: string) => {
      // Try the canonical title first, then each alias in
      // declared order. The backend OR-joins title+aliases into the
      // FTS query so an alias-only mention surfaces here; without the
      // fallback, `replace(regex(pageTitle), …)` silently no-ops and
      // the optimistic UI tells the user "linked" while the block
      // re-appears on the next fetch. Empty/whitespace candidates are
      // skipped — `escapeRegExp('')` would compile to a regex that
      // matches at every position and rewrite the first character of
      // the content into the link.
      const candidates = [pageTitle, ...aliases].filter((s) => s.trim().length > 0)
      let newContent = content
      let replaced = false
      for (const term of candidates) {
        const regex = new RegExp(escapeRegExp(term), 'i')
        if (regex.test(content)) {
          newContent = content.replace(regex, `[[${pageId}]]`)
          replaced = true
          break
        }
      }
      if (!replaced) {
        // Reachable when the backend FTS5 match succeeds on a token
        // the regex literal-matcher can't see (e.g. trigram-tokenized
        // CJK aliases, or aliases added between the search and the
        // click). Reuse the existing toast so the user sees something
        // other than a silent removal — keeping the failure mode
        // Visible was the whole point of.
        logger.warn('UnlinkedReferences', 'No title/alias match found for Link it', {
          blockId,
          pageId,
        })
        notify.error(t('unlinkedRefs.linkFailed'))
        return
      }
      try {
        await editBlock(blockId, newContent)
        // Optimistic removal. `groups`/`totalCount` are now derived from the
        // query cache, so the old `setGroups(...)` + `setTotalCount(prev-1)` is
        // reproduced by rewriting the cached pages in place: strip the linked
        // block from every group, drop groups that become empty, and decrement
        // the count by exactly one. `editBlock` only changes content — it emits
        // no `block:properties-changed`, so nothing else refetches this; the
        // update is purely optimistic (no invalidate).
        queryClient.setQueryData<InfiniteData<GroupedBacklinkResponse>>(queryKey, (old) => {
          if (!old) return old
          const lastIdx = old.pages.length - 1
          const pages: GroupedBacklinkResponse[] = []
          old.pages.forEach((page, idx) => {
            const pageGroups = Array.isArray(page.groups) ? page.groups : []
            // Fresh group objects, dropping the linked block; groups that become
            // empty are removed. `forEach`/`push` (not `.map(...spread)`) keeps
            // the objects fresh — #1529 — without tripping `no-map-spread`.
            const nextGroups: BacklinkGroup[] = []
            for (const g of pageGroups) {
              const blocks = g.blocks.filter((b) => b.id !== blockId)
              if (blocks.length > 0) nextGroups.push({ ...g, blocks })
            }
            // `totalCount` derives from the LAST page (see `useUnlinkedReferences`),
            // so decrement there so the header count drops by exactly one —
            // matching the old `setTotalCount(prev => prev - 1)`.
            pages.push({
              ...page,
              groups: nextGroups,
              total_count: idx === lastIdx ? page.total_count - 1 : page.total_count,
            })
          })
          return { ...old, pages }
        })
      } catch (err) {
        logger.error('UnlinkedReferences', 'Failed to link block to page', { blockId, pageId }, err)
        notify.error(t('unlinkedRefs.linkFailed'))
      }
    },
    [pageId, pageTitle, aliases, t, queryKey],
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

  const pageTitles = useMemo(() => {
    const map = new Map<string, string>()
    // Defensive narrowing: some App-level tests resolve
    // `listUnlinkedReferences` with a stubbed response where `groups` is not an
    // array. Before this guard, the `for..of` below threw inside render and
    // React printed a four-line "above error occurred in <UnlinkedReferences>"
    // banner per affected test. Falling back to an empty array keeps stderr
    // clean while still exercising the error-boundary path.
    const safeGroups = Array.isArray(groups) ? groups : []
    for (const g of safeGroups) {
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

  useFocusedRowEffect({
    containerRef: listRef,
    focusedRowId: focusedBlockId,
    rowAttr: 'data-backlink-item',
    focusClasses: UNLINKED_FOCUS_CLASSES_ARR,
    setFocusedIndex,
    resetDeps: [groups, expandedGroups, setFocusedIndex],
  })

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

  // Render nothing when there are no unlinked references (and not loading): an
  // empty panel is clutter at the bottom of every page. This intentionally
  // Overrides the older empty-state mandate for this panel (user
  // decision, live UX review). When filters are active, keep the full panel
  // visible so the user can clear/adjust filters — otherwise the filter
  // controls vanish. The loading branch below still renders so nothing flashes
  // mid-fetch.
  if (!loading && totalCount === 0 && groups.length === 0 && filters.length === 0) {
    return null
  }

  return (
    <section
      className="unlinked-references"
      aria-label={t('unlinkedRefs.panelLabel')}
      data-testid="unlinked-references"
    >
      {/* Main header — collapsible, collapsed by default */}
      <div className="flex flex-nowrap items-center gap-1 min-w-0">
        <CollapsiblePanelHeader
          isCollapsed={collapsed}
          onToggle={toggleCollapsed}
          className="unlinked-references-header"
        >
          {headerLabel}
        </CollapsiblePanelHeader>
        {!collapsed && filters.length > 0 && (
          <Badge
            tone="secondary"
            className="unlinked-references-filter-count shrink-0 h-5 min-w-5 px-1.5 text-xs"
            aria-label={t('references.filtersAppliedAriaLabel', { count: filters.length })}
          >
            {t('references.filtersAppliedBadge', { count: filters.length })}
          </Badge>
        )}
      </div>

      {!collapsed && (
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
                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- kept as role="status" so the loading indicator is discoverable via [role="status"]; <output> drops the explicit attribute relied on by callers/tests
                role="status"
              >
                <Spinner /> {t('unlinkedRefs.loading')}
              </div>
            }
            empty={<EmptyState compact message={t('unlinkedRefs.noResults')} />}
          >
            {() => (
              <>
                {/* Linked-vs-Unlinked distinction badge */}
                <div className="unlinked-references-link-type-badge flex justify-end px-2 pb-1">
                  <Badge tone="outline" className="text-muted-foreground">
                    {t('references.unlinkedBadge')}
                  </Badge>
                </div>
                {/* Group list */}
                {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- focusable group implements roving keyboard navigation over reference rows; keydown delegation belongs on the container */}
                <div
                  ref={listRef}
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- focusable container implementing roving keyboard navigation over reference rows; <fieldset>/<optgroup> etc. add form/list semantics and break the layout
                  role="group"
                  // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard nav requires focusable container
                  tabIndex={0}
                  onKeyDown={handleContainerKeyDown}
                  aria-label={t('unlinkedRefs.listLabel')}
                  // #2263 — expose the roving keyboard position to AT. Rows here
                  // contain interactive controls (block button + "Link it"), so
                  // the listbox/option model is out (nested-interactive); use
                  // the APG composite alternative: aria-activedescendant on the
                  // focusable container + aria-current on the active row.
                  aria-activedescendant={
                    focusedBlockId ? unlinkedRowDomId(focusedBlockId) : undefined
                  }
                  className="unlinked-references-list focus-ring-visible"
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
                      onPageTitleClick: (clickedPageId: string, title: string) =>
                        onNavigateToPage(clickedPageId, title),
                    })}
                    renderBlock={(block, _group) => (
                      <li
                        key={block.id}
                        id={unlinkedRowDomId(block.id)}
                        data-backlink-item={block.id}
                        // #2263 — roving position exposed to AT (container hosts
                        // aria-activedescendant → this row's id).
                        aria-current={block.id === focusedBlockId ? true : undefined}
                        className={cn(
                          'unlinked-reference-item flex items-center gap-3 border-b py-1.5 px-2 last:border-b-0',
                          block.id === focusedBlockId && UNLINKED_FOCUS_CLASSES,
                        )}
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
                          aria-label={t('backlinks.linkMention', {
                            text: (block.content ?? '').slice(0, 40),
                          })}
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
                  loading={isFetchingMore}
                  onLoadMore={loadMore}
                  className="unlinked-references-load-more"
                  label={t('unlinkedRefs.loadMore')}
                  loadingLabel={t('unlinkedRefs.loadingDots')}
                  ariaLabel={t('unlinkedRefs.loadMoreLabel')}
                  ariaLoadingLabel={t('unlinkedRefs.loadingMore')}
                  loadedCount={groups.reduce((sum, g) => sum + g.blocks.length, 0)}
                  totalCount={totalCount}
                />
                {truncated && (
                  <p className="px-3 py-1.5 text-xs text-muted-foreground italic">
                    {t('unlinkedRefs.truncated')}
                  </p>
                )}
              </>
            )}
          </ListViewState>
        </div>
      )}
    </section>
  )
}
