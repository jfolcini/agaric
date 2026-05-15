/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 *
 * Top-level orchestrator: owns data loading, filter state, and dialog
 * open state, then composes `PageBrowserHeader` + `PageBrowserRowRenderer`
 * inside a virtualized list. Sort preference + grouping live in
 * `usePageBrowserSort` / `usePageBrowserGrouping` (MAINT-128).
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { FileText, Plus, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { PAGINATION_LIMIT } from '@/lib/constants'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { usePageBrowserGrouping } from '../hooks/usePageBrowserGrouping'
import { usePageBrowserSort } from '../hooks/usePageBrowserSort'
import { usePageDelete } from '../hooks/usePageDelete'
import { usePaginatedQuery } from '../hooks/usePaginatedQuery'
import { useRegisterPrimaryFocus } from '../hooks/usePrimaryFocus'
import { useStarredPages } from '../hooks/useStarredPages'
import type { BlockRow } from '../lib/tauri'
import { createPageInSpace, listBlocks, resolvePageByAlias } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { EmptyState } from './EmptyState'
import { LoadMoreButton } from './LoadMoreButton'
import { PageBrowserHeader } from './PageBrowser/PageBrowserHeader'
import { PageBrowserRowRenderer } from './PageBrowser/PageBrowserRowRenderer'
import { ViewHeader } from './ViewHeader'

const HEADER_ROW_HEIGHT = 36
const PAGE_ROW_HEIGHT = 44

/// Bottom-of-list proximity in CSS pixels at which the auto-load
/// pixel-trigger fires. Picked to give ~5-7 rows of headroom at the
/// 44px PAGE_ROW_HEIGHT so the next page lands before the user hits
/// the LoadMoreButton fallback.
const INFINITE_SCROLL_BOTTOM_THRESHOLD_PX = 300

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string, title?: string) => void
}

export function PageBrowser({ onPageSelect }: PageBrowserProps): React.ReactElement {
  const { t } = useTranslation()

  // FEAT-3 Phase 2 — honour the current space. When the `SpaceStore`
  // has not yet hydrated (`isReady === false`) we render a
  // `LoadingSkeleton` instead of firing `listBlocks` so the first render
  // never leaks cross-space pages. Once ready, `currentSpaceId` is
  // threaded to `listBlocks` so the backend filters results.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)

  const queryFn = useCallback(
    (cursor?: string) =>
      // FEAT-3 Phase 4 — `listBlocks` requires `spaceId`. The `?? ''`
      // fallback is intentional pre-bootstrap behaviour: the empty
      // string forces a no-match SQL filter (returning an empty page)
      // instead of a runtime null deref. The `enabled: spaceIsReady`
      // gate below normally prevents this branch from firing.
      listBlocks({
        blockType: 'page',
        ...(cursor != null && { cursor }),
        limit: PAGINATION_LIMIT,
        spaceId: currentSpaceId ?? '',
      }),
    [currentSpaceId],
  )
  const {
    items: pages,
    loading,
    hasMore,
    loadMore,
    setItems: setPages,
    totalCount,
  } = usePaginatedQuery(queryFn, {
    onError: t('pageBrowser.loadFailed'),
    enabled: spaceIsReady,
  })

  const { deleteTarget, deletingId, setDeleteTarget, handleConfirmDelete } = usePageDelete(setPages)

  const [isCreating, setIsCreating] = useState(false)
  const [newPageName, setNewPageName] = useState('')
  const [filterText, setFilterText] = useState('')
  const { sortOption, setSortOption, sortPages } = usePageBrowserSort()
  const { starredIds, isStarred, toggle: toggleStar } = useStarredPages()
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  const [aliasMatchId, setAliasMatchId] = useState<string | null>(null)
  // Stable id base for section header `aria-labelledby` wiring. Two
  // headers (`starred` and `other`) share the same prefix.
  const sectionLabelId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const newPageInputRef = useRef<HTMLInputElement>(null)
  // Register the "new page" input as the primary-focus target for this view
  // so switching to Pages via sidebar lands the cursor in the create form
  // instead of the generic #main-content container (UX-220).
  useRegisterPrimaryFocus(newPageInputRef)
  // Tracks the handleCreateUnder focus setTimeout so we can cancel it on
  // unmount and avoid focusing a stale DOM node (#MAINT-14).
  const pendingFocusRef = useRef<number | null>(null)
  // PEND-29 B-2: monotonic request id for alias resolution. When the user
  // types fast, the older `resolvePageByAlias` promise can resolve after the
  // newer one and overwrite `aliasMatchId` with stale data; the request-id
  // pattern (mirrors `useQueryExecution` post-PEND-22) discards results from
  // any but the most recent in-flight request.
  const aliasReqIdRef = useRef(0)

  // Clear any pending focus timer on unmount.
  useEffect(
    () => () => {
      if (pendingFocusRef.current !== null) {
        window.clearTimeout(pendingFocusRef.current)
        pendingFocusRef.current = null
      }
    },
    [],
  )

  // Track load-more announcements for screen readers
  const prevLengthRef = useRef(0)
  useEffect(() => {
    if (pages.length > prevLengthRef.current && prevLengthRef.current > 0) {
      setLoadMoreAnnouncement(
        t('pageBrowser.loadedMorePages', { count: pages.length - prevLengthRef.current }),
      )
    } else if (pages.length < prevLengthRef.current) {
      setLoadMoreAnnouncement('')
    }
    prevLengthRef.current = pages.length
  }, [pages.length, t])

  // Alias resolution for filter (PEND-29 B-2: stale-fetch guard via
  // request-id ref so an older promise resolving after a newer one cannot
  // overwrite `aliasMatchId` with stale data).
  useEffect(() => {
    if (!filterText.trim()) {
      setAliasMatchId(null)
      return
    }
    const myReqId = ++aliasReqIdRef.current
    const query = filterText.trim()
    // PEND-35 Tier 1.2 — pass `spaceId: currentSpaceId` so an alias
    // pointing at a foreign-space page does not surface here.
    resolvePageByAlias({ alias: query, spaceId: currentSpaceId })
      .then((result) => {
        if (myReqId !== aliasReqIdRef.current) return
        setAliasMatchId(result ? result[0] : null)
      })
      .catch((err) => {
        if (myReqId !== aliasReqIdRef.current) return
        logger.warn('PageBrowser', 'alias resolution failed', { query }, err)
        setAliasMatchId(null)
      })
  }, [filterText, currentSpaceId])

  const handleCreatePage = useCallback(async () => {
    const name = newPageName.trim() || t('pageBrowser.untitled')
    // FEAT-3 Phase 2 — a page must belong to a space. On the rare
    // first-boot path where `SpaceStore` has not yet hydrated we
    // refuse to create and surface a toast rather than silently
    // creating an unscoped page. The `isReady` gate above normally
    // prevents this branch from firing.
    const activeSpaceId = useSpaceStore.getState().currentSpaceId
    if (activeSpaceId == null) {
      notify.error(t('pageBrowser.spaceNotReady'))
      return
    }
    setIsCreating(true)
    try {
      const newId = await createPageInSpace({ content: name, spaceId: activeSpaceId })
      const newPage: BlockRow = {
        id: newId,
        block_type: 'page',
        content: name,
        parent_id: null,
        position: null,
        deleted_at: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
        page_id: newId,
      }
      setPages((prev) => [newPage, ...prev])
      setNewPageName('')
      onPageSelect?.(newId, name)
    } catch (error) {
      notify.error(t('pageBrowser.createFailed', { error: String(error) }), {
        action: { label: t('pageBrowser.retry'), onClick: () => handleCreatePage() },
      })
    }
    setIsCreating(false)
  }, [newPageName, setPages, t, onPageSelect])

  const handleCreateUnder = useCallback((namespacePath: string) => {
    setNewPageName(`${namespacePath}/`)
    if (pendingFocusRef.current !== null) {
      window.clearTimeout(pendingFocusRef.current)
    }
    pendingFocusRef.current = window.setTimeout(() => {
      pendingFocusRef.current = null
      formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    }, 0)
  }, [])

  /**
   * Pages narrowed by the search input + alias resolver.
   * Sort/grouping is applied below — both `Starred` and `Pages`
   * sections consume the same filtered pool.
   */
  const filteredPagesUnsorted = useMemo(() => {
    const trimmed = filterText.trim()
    if (!trimmed) return pages
    // UX-247 — Unicode-aware case- / diacritic-insensitive match so
    // Turkish (`İstanbul` ↔ `istanbul`), German (`Straße` ↔
    // `strasse`), and accented (`café` ↔ `cafe`) titles fold together
    // the way users expect from interactive filters.
    return pages.filter(
      (p) => matchesSearchFolded(p.content ?? '', trimmed) || p.id === aliasMatchId,
    )
  }, [pages, filterText, aliasMatchId])

  // Whether ANY page in the unfiltered set is namespaced. Used only
  // to decide whether to take the single-page-vault shortcut. Pulled
  // out so the grouping memo below doesn't read `pages` directly
  // (keeps its dependency surface tight and lets biome's
  // useExhaustiveDependencies trace stay clean).
  const hasAnyNamespacedPage = useMemo(
    () => pages.some((p) => (p.content ?? '').includes('/')),
    [pages],
  )
  const isSinglePageVault = pages.length <= 1 && !hasAnyNamespacedPage

  const { filteredPages, groupedRows, pageIndexToRowIndex, hasStarred, hasPages } =
    usePageBrowserGrouping({
      filteredPagesUnsorted,
      sortPages,
      sortOption,
      starredIds,
      isSinglePageVault,
    })

  const virtualItemCount = groupedRows.length

  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: filteredPages.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const page = filteredPages[idx]
      if (page) onPageSelect?.(page.id, page.content ?? undefined)
    },
  })

  // Reset focusedIndex when filter/sort changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: filterText and sortOption intentionally trigger reset
  useEffect(() => {
    setFocusedIndex(0)
  }, [filterText, sortOption, setFocusedIndex])

  // PEND-30 L-5: wrap `estimateSize` in `useCallback` so its identity is
  // stable across re-renders that don't change `groupedRows`. TanStack
  // Virtual treats option-identity changes as a re-measure trigger.
  const estimateSize = useCallback(
    (index: number) => {
      const row = groupedRows[index]
      if (row?.kind === 'header') return HEADER_ROW_HEIGHT
      // Both `page` and `tree-page` share the 44px row height. The
      // virtualizer's `measureElement` ref handler later corrects to
      // actual height when descendants expand the wrapper.
      return PAGE_ROW_HEIGHT
    },
    [groupedRows],
  )

  const virtualizer = useVirtualizer({
    count: virtualItemCount,
    getScrollElement: () => listRef.current,
    // Header rows (~36px) sentinel-interspersed between page rows
    // (~44px) and tree-page rows (~44px for the root; descendants
    // render inside the same DOM wrapper).
    estimateSize,
    overscan: 5,
  })

  // PageBrowser pagination UX (2026-05-14) — sessionStorage-backed
  // scroll restoration. The user clicks a page → editor → Back, and
  // PageBrowser remounts; without this they land at row 0 even when
  // they were halfway down a 300-page list. The save side debounces
  // via a ref-tracked timeout (no `requestIdleCallback` because not
  // every test/browser has it and the cost is the same single
  // setTimeout); the restore side fires once per mount AFTER the
  // first batch hydrates so the virtualizer has a non-zero total
  // size to scroll inside of.
  //
  // Key is per-space so switching spaces and back restores each
  // space's last position independently. Filter / sort changes
  // clear the saved offset because the saved position is meaningless
  // against a re-ordered or re-filtered set.
  const scrollStorageKey =
    currentSpaceId != null ? `pageBrowser:scrollOffset:${currentSpaceId}` : null
  const restoredRef = useRef(false)
  const scrollSaveTimerRef = useRef<number | null>(null)

  // Reset the restore-once latch when the storage key changes (space
  // switch). Each space gets its own first-batch restoration; without
  // this, switching to space B and back to space A would skip
  // restoration for A because `restoredRef.current` was set during
  // A's first mount in this session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm only on key change
  useEffect(() => {
    restoredRef.current = false
  }, [scrollStorageKey])

  // Restore once per (mount, space) tuple, after items hydrate.
  useEffect(() => {
    if (restoredRef.current) return
    if (scrollStorageKey == null) return
    if (pages.length === 0) return
    const totalSize = virtualizer.getTotalSize()
    if (totalSize <= 0) return
    const raw = sessionStorage.getItem(scrollStorageKey)
    if (raw == null) {
      restoredRef.current = true
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) {
      restoredRef.current = true
      return
    }
    // Bound to [0, totalSize] in case the list shrank between
    // sessions (pages deleted in another tab, etc.).
    const bounded = Math.min(parsed, totalSize)
    virtualizer.scrollToOffset(bounded, { align: 'start' })
    restoredRef.current = true
  }, [pages.length, virtualizer, scrollStorageKey])

  // Save scroll offset on scroll (debounced ~150ms).
  useEffect(() => {
    const el = listRef.current
    if (el == null) return
    if (scrollStorageKey == null) return
    function handleScroll() {
      if (scrollSaveTimerRef.current != null) {
        window.clearTimeout(scrollSaveTimerRef.current)
      }
      scrollSaveTimerRef.current = window.setTimeout(() => {
        scrollSaveTimerRef.current = null
        // Read at flush time, not at scroll time, so the saved
        // value reflects the user's final resting offset rather
        // than every intermediate frame.
        if (el == null || scrollStorageKey == null) return
        sessionStorage.setItem(scrollStorageKey, String(el.scrollTop))
      }, 150)
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', handleScroll)
      if (scrollSaveTimerRef.current != null) {
        window.clearTimeout(scrollSaveTimerRef.current)
        scrollSaveTimerRef.current = null
      }
    }
  }, [scrollStorageKey])

  // Clear saved offset when filter / sort / space changes — the saved
  // offset is keyed only by space, so a filter or sort change against
  // the same space would otherwise restore a meaningless position the
  // next time the user revisits this view. Allow restoration again on
  // next mount by leaving `restoredRef` intact within this mount but
  // dropping the stored value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollStorageKey already covers space changes; filterText and sortOption are the explicit triggers
  useEffect(() => {
    if (scrollStorageKey == null) return
    // Skip the very first run (mount) — that's when we want to
    // restore, not clear. `restoredRef.current === false` means we
    // haven't tried yet; the restore effect will handle it. After
    // restoration completes, any subsequent change clears.
    if (!restoredRef.current) return
    sessionStorage.removeItem(scrollStorageKey)
  }, [filterText, sortOption])

  // PageBrowser pagination UX (2026-05-14) — auto-load near the
  // bottom. The index-based trigger (last *visible* virtual item
  // within ~5 rows of the end) works in flat view. In tree view a
  // single `tree-page` row can wrap hundreds of expanded descendant
  // nodes, so `lastVisibleIndex` may stay pinned at a low index as
  // the user scrolls through that one tree's descendants — the
  // pixel-based trigger below catches that case. Both triggers
  // short-circuit on `!hasMore || loading` so concurrent firings
  // collapse to one `loadMore()` call (which `usePaginatedQuery`
  // additionally guards on `nextCursor && !loading`). The
  // `<LoadMoreButton>` stays rendered as the a11y / no-JS /
  // reduced-motion fallback.
  const virtualItems = virtualizer.getVirtualItems()
  const lastVisibleIndex = virtualItems.at(-1)?.index
  useEffect(() => {
    if (!hasMore || loading) return
    if (lastVisibleIndex == null) return
    if (lastVisibleIndex >= virtualItemCount - 5) {
      loadMore()
    }
  }, [lastVisibleIndex, hasMore, loading, loadMore, virtualItemCount])

  // Pixel-based bottom-proximity trigger — fires when the viewport's
  // bottom edge is within `INFINITE_SCROLL_BOTTOM_THRESHOLD_PX` of
  // the scroll container's full height. Complements the index-based
  // trigger above for tree view (one expanded tree-page row may
  // exceed the viewport vertically; the index-based check never
  // advances past that row even as the user scrolls inside it).
  const hasMoreRef = useRef(hasMore)
  const loadingRef = useRef(loading)
  const loadMoreRef = useRef(loadMore)
  hasMoreRef.current = hasMore
  loadingRef.current = loading
  loadMoreRef.current = loadMore
  useEffect(() => {
    const el = listRef.current
    if (el == null) return
    function handleScroll() {
      if (!hasMoreRef.current || loadingRef.current) return
      if (el == null) return
      const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (remaining <= INFINITE_SCROLL_BOTTOM_THRESHOLD_PX) {
        loadMoreRef.current()
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
    // Empty deps + refs above: listener attaches once per mount, and
    // the refs always carry the latest hasMore/loading/loadMore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Document-level keydown: skip if user is typing in input/select/textarea
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'TEXTAREA'
      )
        return
      if (navHandleKeyDown(e)) {
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [navHandleKeyDown])

  // Scroll focused item into view. `focusedIndex` indexes into the
  // page-only `filteredPages` array; sentinel headers shift the row
  // index in the virtualizer, so map through `pageIndexToRowIndex`.
  useEffect(() => {
    if (focusedIndex < 0) return
    const rowIndex = pageIndexToRowIndex[focusedIndex] ?? focusedIndex
    virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
  }, [focusedIndex, virtualizer, pageIndexToRowIndex])

  // UX-331 — wire `aria-activedescendant` so screen readers can track
  // arrow-key focus moves. The id pattern mirrors the row renderer:
  // flat rows expose `page-row-${page.id}`; namespace-tree wrappers
  // expose `page-row-${node.fullPath}` (see `PageBrowserRowRenderer`).
  const activeDescendantId = useMemo<string | undefined>(() => {
    if (focusedIndex < 0) return undefined
    const rowIdx = pageIndexToRowIndex[focusedIndex]
    if (rowIdx == null) return undefined
    const row = groupedRows[rowIdx]
    if (!row) return undefined
    if (row.kind === 'page') return `page-row-${row.page.id}`
    if (row.kind === 'tree-page') return `page-row-${row.node.fullPath}`
    return undefined
  }, [focusedIndex, pageIndexToRowIndex, groupedRows])

  const isFiltering = filterText.trim().length > 0

  return (
    <div className="page-browser space-y-4">
      <ViewHeader>
        <PageBrowserHeader
          formRef={formRef}
          newPageInputRef={newPageInputRef}
          newPageName={newPageName}
          onNewPageNameChange={setNewPageName}
          isCreating={isCreating}
          onSubmit={handleCreatePage}
          showSearchAndSort={pages.length > 0}
          filterText={filterText}
          onFilterTextChange={setFilterText}
          sortOption={sortOption}
          onSortChange={setSortOption}
          totalCount={totalCount}
          filteredCount={filteredPages.length}
          isFiltering={isFiltering}
        />
      </ViewHeader>

      {(!spaceIsReady || (loading && pages.length === 0)) && (
        <LoadingSkeleton count={3} height="h-10" loading className="page-browser-loading" />
      )}

      {spaceIsReady && !loading && pages.length === 0 && (
        <EmptyState
          icon={FileText}
          message={t('pageBrowser.noPages')}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 mx-auto flex items-center gap-1"
              onClick={handleCreatePage}
              disabled={isCreating}
            >
              {isCreating ? <Spinner /> : <Plus className="h-4 w-4" />}
              {t('pageBrowser.createFirst')}
            </Button>
          }
        />
      )}

      <ScrollArea
        viewportRef={listRef}
        className="page-browser-list max-h-[calc(100dvh-200px)]"
        viewportProps={{
          // MAINT-162 — ARIA grid pattern for the page list. The
          // viewport mixes flat-page rows, section headers, and
          // namespace-tree rows under one container; `role="grid"`
          // permits this heterogeneous mix where `role="listbox"`
          // would have required every child to be `role="option"`.
          role: 'grid',
          tabIndex: 0,
          'aria-label': hasStarred ? t('pageBrowser.pageListGrouped') : t('pageBrowser.pageList'),
          // UX-331 — bind `aria-activedescendant` to the focused row's
          // stable id so screen readers track arrow-key focus moves
          // without the inner buttons having to receive DOM focus.
          ...(activeDescendantId ? { 'aria-activedescendant': activeDescendantId } : {}),
          // Section presence flags exposed for tests / styling hooks.
          // FEAT-14 — the unified model means either or both can be
          // present independently; consumers that want section-aware
          // chrome key off these data attributes.
          'data-has-starred': hasStarred ? 'true' : 'false',
          'data-has-pages': hasPages ? 'true' : 'false',
        }}
      >
        {isFiltering && filteredPages.length === 0 ? (
          <EmptyState icon={Search} message={t('pageBrowser.noMatches')} />
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualRow) => {
              const row = groupedRows[virtualRow.index]
              if (!row) return null
              return (
                <PageBrowserRowRenderer
                  key={virtualRow.key}
                  virtualRow={virtualRow}
                  row={row}
                  measureElement={virtualizer.measureElement}
                  focusedIndex={focusedIndex}
                  hasStarred={hasStarred}
                  sectionLabelId={sectionLabelId}
                  filterText={filterText}
                  isFiltering={isFiltering}
                  aliasMatchId={aliasMatchId}
                  deletingId={deletingId}
                  isStarred={isStarred}
                  toggleStar={toggleStar}
                  onPageSelect={onPageSelect}
                  onCreateUnder={handleCreateUnder}
                  onDeleteRequest={setDeleteTarget}
                />
              )
            })}
          </div>
        )}
      </ScrollArea>

      <LoadMoreButton
        hasMore={hasMore}
        loading={loading}
        onLoadMore={loadMore}
        className="page-browser-load-more"
        label={t('pageBrowser.loadMore')}
        loadingLabel={t('pageBrowser.loading')}
        loadedCount={pages.length}
        totalCount={totalCount}
      />

      <output className="sr-only" aria-live="polite">
        {loadMoreAnnouncement}
      </output>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={t('pageBrowser.deletePage')}
        description={t('pageBrowser.deleteDescription', { name: deleteTarget?.name })}
        cancelLabel={t('pageBrowser.cancel')}
        actionLabel={t('pageBrowser.delete')}
        actionVariant="destructive"
        onAction={handleConfirmDelete}
      />
    </div>
  )
}
