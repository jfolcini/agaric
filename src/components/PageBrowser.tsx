/**
 * PageBrowser — lists all page blocks (p15-t22).
 *
 * WHERE block_type = 'page' AND deleted_at IS NULL.
 * Default sort: ULID ascending (oldest first) via cursor pagination.
 * Includes delete with confirmation dialog and toast error feedback.
 *
 * Top-level orchestrator: it composes a set of cohesive hooks — data +
 * delete (`usePageBrowserData`), compound/text filters
 * (`usePageBrowserFilters`), the create-page flow (`usePageCreation`),
 * sort/grouping/density (`usePageBrowserSort` / `usePageBrowserGrouping` /
 * `usePageBrowserDensity`), and the virtualized-list concerns
 * (scroll-restoration, auto-load, keyboard) — then renders
 * `PageBrowserHeader` + `PageBrowserRowRenderer` inside a virtualized
 * List (#1263).
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { FileText, Plus, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { ViewHeader } from '@/components/layout/ViewHeader'
import { PageBrowserBatchToolbar } from '@/components/pages/PageBrowserBatchToolbar'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { matchesSearchFolded } from '@/lib/fold-for-search'

import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { useListMultiSelect } from '../hooks/useListMultiSelect'
import { usePageBrowserAutoLoad } from '../hooks/usePageBrowserAutoLoad'
import { usePageBrowserData } from '../hooks/usePageBrowserData'
import { DENSITY_ROW_HEIGHT, usePageBrowserDensity } from '../hooks/usePageBrowserDensity'
import { useFilterAnnouncementSettle, usePageBrowserFilters } from '../hooks/usePageBrowserFilters'
import { usePageBrowserGrouping } from '../hooks/usePageBrowserGrouping'
import { usePageBrowserKeyboard } from '../hooks/usePageBrowserKeyboard'
import { usePageBrowserScrollRestoration } from '../hooks/usePageBrowserScrollRestoration'
import { isFrontendOnlySort, usePageBrowserSort } from '../hooks/usePageBrowserSort'
import { usePageCreation } from '../hooks/usePageCreation'
import { useStarredPages } from '../hooks/useStarredPages'
import type { BlockRow } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { PageBrowserFilterRow } from './PageBrowser/PageBrowserFilterRow'
import { PageBrowserHeader } from './PageBrowser/PageBrowserHeader'
import { PageBrowserRowRenderer } from './PageBrowser/PageBrowserRowRenderer'

const HEADER_ROW_HEIGHT = 36

interface PageBrowserProps {
  /** Called when a page is selected. */
  onPageSelect?: (pageId: string, title?: string) => void
}

export function PageBrowser({ onPageSelect }: PageBrowserProps): React.ReactElement {
  const { t } = useTranslation()

  // Phase 2 — honour the current space. When the `SpaceStore`
  // has not yet hydrated (`isReady === false`) we render a
  // `LoadingSkeleton` instead of firing the page query so the first
  // render never leaks cross-space pages. Once ready, `currentSpaceId`
  // is threaded to `listPagesWithMetadata` so the backend filters
  // results.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const spaceIsReady = useSpaceStore((s) => s.isReady)

  // Phase 3 — density preference threaded to
  // `<PageBrowserHeader>` (so the selector works) and to `estimateSize`
  // (so the rows measure correctly per density).
  const { density, setDensity } = usePageBrowserDensity()
  const { sortOption, setSortOption, sortPages } = usePageBrowserSort()

  // Compound/text filter state + the wire-shaped primitives the data
  // query depends on (#1263).
  const {
    filters,
    handleAddFilter,
    handleRemoveFilter,
    handleClearAllFilters,
    tagResolver,
    wireFilters,
    wireFiltersKey,
    filterText,
    setFilterText,
    aliasMatchId,
    filterAnnouncement,
    setFilterAnnouncement,
    filterAnnouncePrefixRef,
    filterAnnouncePendingRef,
  } = usePageBrowserFilters(currentSpaceId)

  // Data-fetch orchestration + delete flow (#1263). `pages` is typed as
  // the union: the query returns `PageWithMetadataRow`, but the
  // optimistic create path prepends a raw `BlockRow`. The grouping
  // pipeline reads only the shared `BlockRow` fields.
  const {
    pages,
    loading,
    hasMore,
    loadMore,
    reload,
    setPages,
    displayTotalCount,
    setDisplayTotalCount,
    deleteTarget,
    deletingId,
    setDeleteTarget,
    handleConfirmDelete,
  } = usePageBrowserData({
    currentSpaceId,
    spaceIsReady,
    sortOption,
    wireFilters,
    wireFiltersKey,
  })

  // Create-page flow (#1263).
  const {
    newPageName,
    setNewPageName,
    isCreating,
    handleCreatePage,
    handleCreateUnder,
    formRef,
    newPageInputRef,
  } = usePageCreation({
    wireFilters,
    reload,
    setPages,
    setDisplayTotalCount,
    onPageSelect,
  })

  const { starredIds, isStarred, toggle: toggleStar } = useStarredPages()
  const [loadMoreAnnouncement, setLoadMoreAnnouncement] = useState('')
  // Stable id base for section header `aria-labelledby` wiring. Two
  // headers (`starred` and `other`) share the same prefix.
  const sectionLabelId = useId()
  const listRef = useRef<HTMLDivElement>(null)

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

  /**
   * Pages narrowed by the search input + alias resolver.
   * Sort/grouping is applied below — both `Starred` and `Pages`
   * sections consume the same filtered pool.
   */
  const filteredPagesUnsorted = useMemo(() => {
    const trimmed = filterText.trim()
    if (!trimmed) return pages
    // Unicode-aware case- / diacritic-insensitive match so
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
  // (keeps its dependency surface tight and lets oxlint's
  // react-hooks/exhaustive-deps trace stay clean).
  const hasAnyNamespacedPage = useMemo(
    () => pages.some((p) => (p.content ?? '').includes('/')),
    [pages],
  )
  const isSinglePageVault = pages.length <= 1 && !hasAnyNamespacedPage

  // The grouping pipeline reads only the shared `id` / `content`
  // fields, which both the optimistic `BlockRow` and the query's
  // `PageWithMetadataRow` carry. The metadata extras (`lastModifiedAt`,
  // `inboundLinkCount`, etc.) are preserved on the row object and
  // re-read at the leaf via a typed cast in `PageBrowserRowRenderer`.
  // Cast to `BlockRow[]` at the grouping boundary so the existing
  // `usePageBrowserGrouping` / `sortPages` signatures stay unchanged.
  const filteredPagesUnsortedAsBlockRows = filteredPagesUnsorted as unknown as BlockRow[]
  const {
    filteredPages,
    groupedRows,
    pageIndexToRowIndex,
    hasStarred,
    hasPages,
    matchedPageCount,
  } = usePageBrowserGrouping({
    filteredPagesUnsorted: filteredPagesUnsortedAsBlockRows,
    sortPages,
    sortOption,
    starredIds,
    isSinglePageVault,
  })

  // #81 / batch multi-select over the visible (flat) page set.
  // Keyed by page id and driven by the same `useListMultiSelect` primitive
  // TrashView / HistoryView use. Selection is additive: it does NOT touch
  // the single-row trash button / `usePageDelete` flow above. `filteredPages`
  // is the flat page list (post sort/group/filter), so select-all and
  // shift-range operate over exactly what the user can see.
  const {
    selected: multiSelected,
    handleRowClick: handleMultiSelectRowClick,
    selectAll: selectAllPages,
    clearSelection: clearMultiSelection,
  } = useListMultiSelect({
    items: filteredPages.filter((p): p is BlockRow => p != null),
    getItemId: (p: BlockRow) => p.id,
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

  // Reset focusedIndex when filter / sort / density changes.
  // Density changes the row height, which moves what's visible at any
  // given scroll offset — keeping `focusedIndex` stable across the
  // toggle would land the focus ring on a row that's no longer where
  // the user is looking.
  useEffect(() => {
    setFocusedIndex(0)
  }, [filterText, sortOption, density, wireFiltersKey, setFocusedIndex])

  // P1-F1 — append the settled result count to the pending filter
  // announcement once the refetch finishes (#1263).
  useFilterAnnouncementSettle({
    loading,
    matchedPageCount,
    filterAnnouncePrefixRef,
    filterAnnouncePendingRef,
    setFilterAnnouncement,
  })

  // Wrap `estimateSize` in `useCallback` so its identity is
  // stable across re-renders that don't change `groupedRows` or
  // density. TanStack Virtual treats option-identity changes as a
  // re-measure trigger — that's exactly what we want on a density
  // flip, since the row height per page changes wholesale.
  const estimateSize = useCallback(
    (index: number) => {
      const row = groupedRows[index]
      if (row?.kind === 'header') return HEADER_ROW_HEIGHT
      // Phase 3 — page-row height now driven by density.
      // `tree-page` rows share the per-density leaf height (the
      // virtualizer's `measureElement` ref handler corrects to the
      // actual height when descendants expand the wrapper). The
      // `regular` value (44 px) matches the pre- fixed height,
      // so flag-off behaviour stays byte-identical.
      return DENSITY_ROW_HEIGHT[density]
    },
    [groupedRows, density],
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
  // scroll restoration (#1263).
  usePageBrowserScrollRestoration({
    listRef,
    currentSpaceId,
    pagesLength: pages.length,
    virtualizer,
    filterText,
    sortOption,
    density,
    wireFiltersKey,
  })

  // PageBrowser pagination UX (2026-05-14) — auto-load near the bottom
  // (index + pixel triggers, #1263).
  const virtualItems = virtualizer.getVirtualItems()
  const lastVisibleIndex = virtualItems.at(-1)?.index
  usePageBrowserAutoLoad({
    listRef,
    hasMore,
    loading,
    loadMore,
    lastVisibleIndex,
    virtualItemCount,
  })

  // Document-level keyboard handling (list nav + batch selection, #1263).
  usePageBrowserKeyboard({
    navHandleKeyDown,
    selectAllPages,
    clearMultiSelection,
    multiSelectedSize: multiSelected.size,
  })

  // Scroll focused item into view. `focusedIndex` indexes into the
  // page-only `filteredPages` array; sentinel headers shift the row
  // index in the virtualizer, so map through `pageIndexToRowIndex`.
  //
  // This must fire ONLY when the user moves focus (arrow keys), never when
  // `pageIndexToRowIndex`'s identity changes as more pages stream in — else
  // every load-more re-runs `scrollToIndex(focusedIndex)` and yanks the
  // viewport back to the focused row (index 0 by default), defeating infinite
  // scroll. The mapping is read from a ref so data growth doesn't re-trigger.
  const pageIndexToRowIndexRef = useRef(pageIndexToRowIndex)
  pageIndexToRowIndexRef.current = pageIndexToRowIndex
  useEffect(() => {
    if (focusedIndex < 0) return
    const rowIndex = pageIndexToRowIndexRef.current[focusedIndex] ?? focusedIndex
    virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
  }, [focusedIndex, virtualizer])

  // Wire `aria-activedescendant` so screen readers can track
  // arrow-key focus moves. The id pattern mirrors the row renderer:
  // flat rows expose `page-row-${page.id}`; namespace-tree wrappers
  // expose `page-row-${node.fullPath}` (see `PageBrowserRowRenderer`).
  //
  // (a11y) — `aria-activedescendant` MUST reference an
  // element that is actually in the DOM. The list is virtualized, so a
  // focused row whose virtual index falls outside the current render
  // window has no rendered element, and pointing the attribute at its id
  // would dangle (ARIA violation; screen readers announce nothing or
  // error). Guard by confirming the focused row's virtual index is within
  // the rendered window (`virtualItems`) before emitting the id;
  // otherwise skip it. The `scrollToIndex` effect above keeps the focused
  // row in view on arrow-key moves, so under normal navigation the id is
  // present — this guard only suppresses the brief window before the
  // virtualizer re-renders around a programmatic jump.
  const renderedRowIndices = useMemo(
    () => new Set(virtualItems.map((vi) => vi.index)),
    [virtualItems],
  )
  const activeDescendantId = useMemo<string | undefined>(() => {
    if (focusedIndex < 0) return undefined
    const rowIdx = pageIndexToRowIndex[focusedIndex]
    if (rowIdx == null) return undefined
    // Skip when the focused row isn't in the current virtual window —
    // its element isn't rendered, so the id would dangle.
    if (!renderedRowIndices.has(rowIdx)) return undefined
    const row = groupedRows[rowIdx]
    if (!row) return undefined
    if (row.kind === 'page') return `page-row-${row.page.id}`
    if (row.kind === 'tree-page') return `page-row-${row.node.fullPath}`
    return undefined
  }, [focusedIndex, pageIndexToRowIndex, groupedRows, renderedRowIndices])

  // P0-B — a chip-only narrowing (empty text box, ≥1 active filter) that
  // returns zero rows must render the "no matches" state, not the
  // "No pages yet / Create your first page" empty-space state. Derive
  // `isFiltering` from the compound `filters` as well as the text input.
  // The count chip needs to tell the two narrowing axes
  // apart (free-text narrows the loaded set; chips narrow server-side), so
  // expose both booleans separately rather than the combined `isFiltering`.
  const hasTextQuery = filterText.trim().length > 0
  const hasChipFilters = filters.length > 0
  const isFiltering = hasTextQuery || hasChipFilters
  // The list viewport shows the "No matching pages" status (instead of
  // the virtualized rows) whenever an active filter resolves to zero
  // rows. Drives both the body branch and the grid-role suppression.
  const showNoMatch = isFiltering && filteredPages.length === 0

  // The frontend-only sorts (`alphabetical`, `recent`,
  // `created`) reorder only the loaded ≤50 rows client-side; their
  // visible order is globally accurate only once every page is loaded.
  // When more pages remain (`hasMore`), surface a cue in the header so
  // the user knows the order covers loaded pages only. `default` and the
  // three server-side sorts are globally accurate, so they never trigger.
  const frontendSortAtScale = isFrontendOnlySort(sortOption) && hasMore

  // E13 — keep the free-text count chip basis-consistent. The text box
  // narrows only the LOADED set client-side, so its numerator
  // (`matchedPageCount`) is loaded-basis. Pairing it with the server
  // filtered total (`displayTotalCount`) would skew "X of Y matching"
  // (a loaded numerator over a server denominator). When a text query is
  // active, drive the denominator from the loaded distinct page count so
  // both ends share the loaded basis — "23 of 50 matching" reads as "23
  // of the 50 loaded pages match". With no text query the chip keeps the
  // server total (forms (a) unfiltered and (c) chips-only in the header).
  // Guard on the server total still being a number so the chip stays
  // hidden when the backend never reported a total (unchanged behaviour).
  const headerTotalCount =
    hasTextQuery && typeof displayTotalCount === 'number' ? pages.length : displayTotalCount

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
          density={density}
          onDensityChange={setDensity}
          // E13 — basis-consistent denominator: server total normally,
          // loaded distinct count when a text query is active (the text
          // box only narrows loaded pages, so a server total there skews).
          totalCount={headerTotalCount}
          // E7 — the count-chip numerator is the DISTINCT matched-page
          // count, not the grouped-row count (`filteredPages` under-counts
          // namespaced subtrees and double-counts starred+namespaced pages).
          filteredCount={matchedPageCount}
          hasTextQuery={hasTextQuery}
          hasChipFilters={hasChipFilters}
          frontendSortAtScale={frontendSortAtScale}
        />
      </ViewHeader>

      {/*  Phase 3 — compound-filter chip-row. Rendered when there
          are pages to groom OR filters are already active — the latter
          keeps the chips reachable when a filter narrows the result set
          to zero, so the user can always remove the filter that emptied
          the view. */}
      {(pages.length > 0 || filters.length > 0) && (
        <PageBrowserFilterRow
          filters={filters}
          onAddFilter={handleAddFilter}
          onRemoveFilter={handleRemoveFilter}
          onClearAll={handleClearAllFilters}
          // Resolve `tag:` chips to tag names (the chip
          // previously showed the raw ULID because no resolver was passed).
          tagResolver={tagResolver}
        />
      )}

      {/* #81 / batch-action toolbar. Rendered only when ≥1 page
          is selected (mirrors Trash/History). After a successful bulk op
          it clears the selection and `reload()`s so the existing query
          refetch path updates the view. */}
      {multiSelected.size > 0 && (
        <PageBrowserBatchToolbar
          selectedIds={Array.from(multiSelected)}
          currentSpaceId={currentSpaceId}
          onSelectAll={selectAllPages}
          onClearSelection={clearMultiSelection}
          onMutated={reload}
        />
      )}

      {(!spaceIsReady || (loading && pages.length === 0)) && (
        <LoadingSkeleton count={3} height="h-10" loading className="page-browser-loading" />
      )}

      {/* P0-B — the empty-space "No pages yet / Create your first page"
          state is only correct when the view is genuinely unfiltered. When
          a chip (or text) narrows the server result to zero, `isFiltering`
          is true and we yield to the `noMatches` branch inside the
          ScrollArea instead, so a user with a full graph isn't told it's
          empty and offered an irrelevant create-first action. */}
      {spaceIsReady && !loading && pages.length === 0 && !isFiltering && (
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
        className="page-browser-list"
        // The height cap must live on the viewport (the actual scroller), not
        // the Root: a `max-height`-only Root has computed `height: auto`, so
        // the viewport's `h-full` can't resolve and grows to full content —
        // defeating virtualization and cascading load-more through every page.
        // Capping the viewport keeps shrink-to-content for short lists while
        // capping + scrolling (and virtualizing) for long ones.
        viewportClassName="max-h-[calc(100dvh-200px)]"
        viewportProps={{
          // ARIA grid pattern for the page list. The
          // viewport mixes flat-page rows, section headers, and
          // namespace-tree rows under one container; `role="grid"`
          // permits this heterogeneous mix where `role="listbox"`
          // would have required every child to be `role="option"`.
          //
          // P0-B / a11y — in the no-match state the only child is the
          // `EmptyState` status `<section>`, which is not a valid grid
          // child (`aria-required-children`). Drop the grid role (and its
          // grid-only ARIA attrs) in that state so the container is a
          // plain region holding the "No matching pages" message.
          ...(showNoMatch
            ? {}
            : {
                role: 'grid',
                'aria-label': hasStarred
                  ? t('pageBrowser.pageListGrouped')
                  : t('pageBrowser.pageList'),
                // Bind `aria-activedescendant` to the focused
                // row's stable id so screen readers track arrow-key
                // focus moves without the inner buttons receiving DOM
                // focus.
                ...(activeDescendantId ? { 'aria-activedescendant': activeDescendantId } : {}),
              }),
          tabIndex: 0,
          // Section presence flags exposed for tests / styling hooks.
          // The unified model means either or both can be
          // present independently; consumers that want section-aware
          // chrome key off these data attributes.
          'data-has-starred': hasStarred ? 'true' : 'false',
          'data-has-pages': hasPages ? 'true' : 'false',
        }}
      >
        {showNoMatch ? (
          <EmptyState icon={Search} message={t('pageBrowser.noMatches')} />
        ) : (
          <>
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
                    density={density}
                    selectedIds={multiSelected}
                    onToggleMultiSelect={handleMultiSelectRowClick}
                  />
                )
              })}
            </div>
            {/* Inside the ScrollArea so the button sits at the bottom of
                the scrollable list (sibling of the virtual rows, not
                positioned past the inner viewport's lower edge). Fixes
                the case where the inner ScrollArea's `max-h` consumed
                the outer viewport and a button rendered below it was
                effectively off-screen.

                 (a11y) — the button is a direct child of the
                `role="grid"` viewport, which `aria-required-children`
                forbids (a grid's children must be rows). Wrap it in a
                `role="row"` > `role="gridcell"` footer so it's a valid
                grid descendant. Rendered only when `hasMore` so the grid
                never carries an empty trailing row once everything is
                loaded (`LoadMoreButton` itself also returns null then). */}
            {hasMore && (
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- row focus is delegated to the inner load-more button; CSS-grid row would break as a <tr> without a <table>
              <div role="row" className="page-browser-load-more-row">
                {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell focus is delegated to the inner load-more button; CSS-grid cell would break as a <td> without a <table> */}
                <div role="gridcell">
                  <LoadMoreButton
                    hasMore={hasMore}
                    loading={loading}
                    onLoadMore={loadMore}
                    className="page-browser-load-more mt-2"
                    label={t('pageBrowser.loadMore')}
                    loadingLabel={t('pageBrowser.loading')}
                    loadedCount={pages.length}
                    totalCount={displayTotalCount}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </ScrollArea>

      <output className="sr-only" aria-live="polite">
        {loadMoreAnnouncement}
      </output>

      {/* P1-F1 — polite announcement of compound-filter add/remove plus the
          settled result count, so screen-reader users hear the central
          chip interaction (which silently refetches the list). */}
      <output className="sr-only" aria-live="polite" data-testid="filter-announcement">
        {filterAnnouncement}
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
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
