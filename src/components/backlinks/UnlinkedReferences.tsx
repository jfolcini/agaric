/**
 * UnlinkedReferences — shows blocks that mention the page title text
 * without a [[link]], grouped by source page.
 *
 * Collapsed by default. Each block result has a `t('unlinkedRefs.linkIt')` button that
 * converts the first plain-text mention into a [[pageId]] link.
 */

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
import type { NavigateToPageFn } from '@/lib/block-events'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { BacklinkFilter, BacklinkGroup, BacklinkSort } from '@/lib/tauri'
import {
  editBlock,
  getPageAliases,
  listTagsByPrefix,
  listUnlinkedReferences,
  paginationLimit,
} from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const UNLINKED_FOCUS_CLASSES = 'ring-2 ring-inset ring-ring/50 bg-accent/30'
const UNLINKED_FOCUS_CLASSES_ARR = UNLINKED_FOCUS_CLASSES.split(' ')

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
  const [groups, setGroups] = useState<BacklinkGroup[]>([])
  const [collapsed, setCollapsed] = useState(true)
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [filters, setFilters] = useState<BacklinkFilter[]>([])
  const [sort, setSort] = useState<BacklinkSort | null>(null)
  // PEND-36 — `eval_unlinked_references` (backend) OR-joins title +
  // aliases into the FTS query, so a block that mentions ONLY an alias
  // surfaces here. The FE-side `handleLinkIt` then needs to know the
  // same alias set to perform the literal-text rewrite, otherwise the
  // regex compiled from `pageTitle` alone misses and the user is told
  // "linked" while the block silently reappears on the next refetch.
  const [aliases, setAliases] = useState<string[]>([])
  // MAINT-189: shared cache replaces per-mount `listPropertyKeys()` IPC.
  const propertyKeys = usePropertyKeysCache(currentSpaceId)
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])

  const fetchGroups = useCallback(
    async (cursor?: string) => {
      setLoading(true)
      try {
        const resp = await listUnlinkedReferences({
          pageId,
          filters: filters.length > 0 ? filters : null,
          sort,
          cursor: cursor ?? null,
          limit: paginationLimit(20),
          spaceId: currentSpaceId,
        })
        // TEST-4a: some callers (notably App-level smoke tests that resolve
        // every `invoke` with a generic empty-page shape) return responses
        // where `groups` is missing. Narrow to an array at the state-setter
        // boundary so every downstream reader can rely on the declared
        // `BacklinkGroup[]` invariant.
        const respGroups = Array.isArray(resp.groups) ? resp.groups : []
        // PEND-83 Bug 2 — pre-warm the resolve cache for source-page IDs.
        // Without this, `useBlockResolve.resolveTitle` falls back to the
        // `[[ULID-prefix...]]` placeholder for any source page that hasn't
        // been visited yet (e.g. a deeply nested child created in another
        // session). The matched-block content path already benefits from
        // `useBacklinkResolution` warming, but the source-page-header path
        // surfaces these IDs directly and needed its own pre-warm.
        const resolveEntries = respGroups
          .filter((g) => g.page_title != null && g.page_title.length > 0)
          .map((g) => ({
            id: g.page_id,
            title: g.page_title as string,
            deleted: false,
          }))
        if (resolveEntries.length > 0) {
          useResolveStore.getState().batchSet(resolveEntries)
        }
        if (cursor) {
          // Append: merge groups with same page_id.
          // FE-L-13: copy-and-replace the matching group instead of
          // reassigning `existing.blocks` on a shared reference — `prev`
          // and `merged` share the same group objects after `[...prev]`.
          setGroups((prev) => {
            const merged = [...prev]
            for (const newGroup of respGroups) {
              const idx = merged.findIndex((g) => g.page_id === newGroup.page_id)
              const existing = idx >= 0 ? merged[idx] : undefined
              if (existing) {
                merged[idx] = { ...existing, blocks: [...existing.blocks, ...newGroup.blocks] }
              } else {
                merged.push(newGroup)
              }
            }
            return merged
          })
        } else {
          setGroups(respGroups)
        }
        setNextCursor(resp.next_cursor)
        setHasMore(resp.has_more)
        setTotalCount(resp.total_count)
        setTruncated(resp.truncated)
      } catch (err) {
        logger.error('UnlinkedReferences', 'Failed to load unlinked references', { pageId }, err)
        notify.error(t('unlinkedRefs.loadFailed'), { id: 'unlinked-refs-load-failed' })
      } finally {
        setLoading(false)
      }
    },
    [pageId, filters, sort, t, currentSpaceId],
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
  useEffect(() => {
    setCollapsed(true)
  }, [pageId])

  // Load tags on mount (PEND-29 B-6: cancellation flag avoids React 19
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
        logger.error('UnlinkedReferences', 'Failed to load tags', undefined, e)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // PEND-36 — load the page's aliases alongside the title so
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
      // PEND-36 — try the canonical title first, then each alias in
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
        // visible was the whole point of PEND-36.
        logger.warn('UnlinkedReferences', 'No title/alias match found for Link it', {
          blockId,
          pageId,
        })
        notify.error(t('unlinkedRefs.linkFailed'))
        return
      }
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
        notify.error(t('unlinkedRefs.linkFailed'))
      }
    },
    [pageId, pageTitle, aliases, t],
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
    // Defensive narrowing (TEST-4a): some App-level tests resolve
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
  // overrides the older UX-152 empty-state mandate for this panel (user
  // decision, live UX review). When filters are active, keep the full panel
  // visible so the user can clear/adjust filters — otherwise the filter
  // controls vanish. The loading branch below still renders so nothing flashes
  // mid-fetch.
  if (!loading && totalCount === 0 && groups.length === 0 && filters.length === 0) {
    return null
  }

  return (
    <section className="unlinked-references" aria-label={t('unlinkedRefs.panelLabel')}>
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
                {/* Linked-vs-Unlinked distinction badge (UX-271) */}
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
                      onPageTitleClick: (pageId: string, title: string) =>
                        onNavigateToPage(pageId, title),
                    })}
                    renderBlock={(block, _group) => (
                      <li
                        key={block.id}
                        data-backlink-item={block.id}
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
                          aria-label={t('backlinks.linkMention', { blockId: block.id.slice(0, 8) })}
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
