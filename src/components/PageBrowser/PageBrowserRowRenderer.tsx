/**
 * PageBrowserRowRenderer — renders a single row inside the `PageBrowser`
 * virtualizer. Dispatches on `row.kind` to one of the three internal
 * sub-renderers (header / page / tree-page). All state is passed in as
 * props — this sibling is presentational and stateless.
 *
 * Extracted from `PageBrowser.tsx` (MAINT-128).
 */

import type { VirtualItem } from '@tanstack/react-virtual'
import { FileText, Star, Trash2 } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { HighlightMatch } from '@/components/common/HighlightMatch'
import { PageTreeItem } from '@/components/pages/PageTreeItem'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { cn } from '@/lib/utils'

import type { DensityMode } from '../../hooks/usePageBrowserDensity'
import type { PageBrowserRow } from '../../hooks/usePageBrowserGrouping'
import type { PageWithMetadataRow } from '../../lib/tauri'
import { DensityRow } from './DensityRow'

export interface PageBrowserRowRendererProps {
  virtualRow: VirtualItem
  row: PageBrowserRow
  measureElement: (el: Element | null) => void
  focusedIndex: number
  hasStarred: boolean
  sectionLabelId: string
  filterText: string
  isFiltering: boolean
  aliasMatchId: string | null
  deletingId: string | null
  isStarred: (pageId: string) => boolean
  toggleStar: (pageId: string) => void
  onPageSelect: ((pageId: string, title?: string) => void) | undefined
  onCreateUnder: (namespacePath: string) => void
  onDeleteRequest: (target: { id: string; name: string } | null) => void
  /**
   * #81 / PEND-57 — batch multi-select. `selectedIds` carries the ids of
   * every page currently in the selection; `onToggleMultiSelect` flips
   * one row. Threaded to the leaf page rows so each renders its
   * selection checkbox. Tree-page and header rows ignore these (the
   * CORE scope selects flat page rows only).
   */
  selectedIds: ReadonlySet<string>
  onToggleMultiSelect: (pageId: string, e: React.MouseEvent) => void
  /**
   * PEND-56 Phase 3 — when `true`, the leaf `page` row is rendered via
   * `<DensityRow>` (metadata-aware, density-aware). When `false`, the
   * legacy `PageRow` is rendered unchanged — this is the default until
   * the `pageBrowser.densityV1` localStorage flag flips.
   */
  flagOn: boolean
  /**
   * PEND-56 Phase 3 — active density mode for the `<DensityRow>` body.
   * Always passed down; `PageRow` ignores it when `flagOn === false`.
   */
  density: DensityMode
}

const rowStyle = (start: number): React.CSSProperties => ({
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  transform: `translateY(${start}px)`,
})

export function PageBrowserRowRenderer(
  props: PageBrowserRowRendererProps,
): React.ReactElement | null {
  const { row } = props
  if (row.kind === 'header') return <HeaderRow {...props} row={row} />
  if (row.kind === 'tree-page') return <TreePageRow {...props} row={row} />
  // PEND-56 Phase 3 — gate the new `<DensityRow>` leaf body behind the
  // `pageBrowser.densityV1` flag (carried as `flagOn`). When the flag
  // is off the existing `PageRow` renders unchanged; when on, the
  // density-aware row reads its metadata via a cast through
  // `PageWithMetadataRow` (the IPC payload is a structural superset).
  if (props.flagOn) return <DensityPageRow {...props} row={row} />
  return <PageRow {...props} row={row} />
}

interface HeaderRowProps extends PageBrowserRowRendererProps {
  row: Extract<PageBrowserRow, { kind: 'header' }>
}

function HeaderRow({
  virtualRow,
  row,
  measureElement,
  hasStarred,
  sectionLabelId,
}: HeaderRowProps): React.ReactElement {
  const { t } = useTranslation()
  const isStarredHeader = row.section === 'starred'
  const visibleLabel = isStarredHeader
    ? t('pageBrowser.starredSection')
    : t('pageBrowser.pagesSection')
  const accessibleLabel = isStarredHeader
    ? t('pageBrowser.starredSectionLabel', { count: row.count })
    : t('pageBrowser.pagesSectionLabel', { count: row.count })
  const labelId = `${sectionLabelId}-${row.section}`
  // The `Pages` header gets a thin top divider when it follows the
  // `Starred` section, separating the two groups visually without
  // an extra DOM node.
  const showDivider = !isStarredHeader && hasStarred
  return (
    // oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- section header row is not interactive
    <div
      key={virtualRow.key}
      data-index={virtualRow.index}
      ref={measureElement}
      data-page-section={row.section}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- CSS-grid row inside role="grid"; a real <tr> needs a <table> and breaks the flex/grid layout
      role="row"
      aria-labelledby={labelId}
      className={cn('page-browser-section', showDivider && 'border-t border-border mt-1')}
      style={rowStyle(virtualRow.start)}
    >
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- gridcell carries the section label — not interactive */}
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- CSS-grid cell inside role="row"; a real <td> needs a <table> and breaks the flex layout
        role="gridcell"
        className="flex items-center gap-2 px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {isStarredHeader ? (
          <Star className="h-3.5 w-3.5 text-star" aria-hidden="true" fill="currentColor" />
        ) : (
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span id={labelId} className="sr-only">
          {accessibleLabel}
        </span>
        <span aria-hidden="true">{visibleLabel}</span>
        <span aria-hidden="true" className="ml-1 font-normal text-muted-foreground/80">
          {row.count}
        </span>
      </div>
    </div>
  )
}

interface TreePageRowProps extends PageBrowserRowRendererProps {
  row: Extract<PageBrowserRow, { kind: 'tree-page' }>
}

function TreePageRow({
  virtualRow,
  row,
  measureElement,
  focusedIndex,
  filterText,
  isFiltering,
  onPageSelect,
  onCreateUnder,
  onDeleteRequest,
}: TreePageRowProps): React.ReactElement {
  const { node, pageIndex, depth } = row
  // Tree-page rows wrap a recursive `PageTreeItem` whose own
  // buttons handle activation/expand. Under MAINT-162 the page-list
  // viewport is `role="grid"`, so each tree-page wrapper is a
  // `role="row"` containing a single `role="gridcell"` that hosts
  // the recursive button tree. For keyboard-nav visibility we apply
  // a focus ring on the wrapper when the row is the focused page
  // index — `aria-selected` is intentionally omitted because the
  // wrapper isn't a single selectable option.
  return (
    // oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- row focus is delegated to inner button controls
    <div
      key={virtualRow.key}
      // UX-331 — stable id so the grid container's `aria-activedescendant`
      // can point at this row when keyboard nav lands on it.
      id={`page-row-${node.fullPath}`}
      data-index={virtualRow.index}
      ref={measureElement}
      data-page-tree-row
      data-page-index={pageIndex}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- CSS-grid row inside role="grid"; a real <tr> needs a <table> and breaks the flex/grid layout
      role="row"
      className={cn(
        focusedIndex === pageIndex && 'rounded-lg ring-2 ring-inset ring-ring/50 bg-accent/30',
      )}
      style={rowStyle(virtualRow.start)}
    >
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus, jsx-a11y/prefer-tag-over-role -- gridcell focus is delegated to inner button controls; CSS-grid cell would break as a <td> without a <table> */}
      <div role="gridcell">
        <PageTreeItem
          node={node}
          depth={depth}
          onNavigate={(pageId, title) => onPageSelect?.(pageId, title)}
          onCreateUnder={onCreateUnder}
          filterText={filterText.trim()}
          forceExpand={isFiltering}
          onDelete={(id, name) => onDeleteRequest({ id, name })}
        />
      </div>
    </div>
  )
}

/**
 * PEND-56 Phase 3 — adapter from the row-renderer's props plus the
 * `PageBrowserRow` discriminated union member to the typed primitive
 * props that `<DensityRow>` expects.
 *
 * The `page` field is typed as `BlockRow` (the grouping hook normalises
 * to it) but, when the `pageBrowser.densityV1` flag is on, the
 * underlying payload is actually a `PageWithMetadataRow`. The two share
 * the `id` / `content` columns by structural overlap, and the metadata
 * fields (`lastModifiedAt`, `inboundLinkCount`, `childBlockCount`,
 * `flags`) live alongside on the same row object — we read them through
 * a typed cast and fall back to safe zero defaults when the cast misses
 * (e.g. an optimistically-inserted `BlockRow` from the create form).
 */
interface DensityPageRowProps extends PageBrowserRowRendererProps {
  row: Extract<PageBrowserRow, { kind: 'page' }>
}

function DensityPageRow({
  virtualRow,
  row,
  measureElement,
  focusedIndex,
  filterText,
  aliasMatchId,
  deletingId,
  isStarred,
  toggleStar,
  onPageSelect,
  onDeleteRequest,
  density,
  selectedIds,
  onToggleMultiSelect,
}: DensityPageRowProps): React.ReactElement {
  const { page, pageIndex } = row
  const trimmedFilter = filterText.trim()
  const showAliasBadge =
    aliasMatchId === page.id &&
    trimmedFilter !== '' &&
    !matchesSearchFolded(page.content ?? '', trimmedFilter)

  // The grouping hook normalises the payload to `BlockRow`; when the
  // flag is on, the row object is actually a `PageWithMetadataRow` with
  // the metadata columns set. Optimistic inserts from the create form
  // are still raw `BlockRow`s — `?? 0` / `?? false` keeps them safe.
  const meta = page as unknown as Partial<PageWithMetadataRow>
  const lastModifiedAt = meta.lastModifiedAt ?? null
  const inboundLinkCount = meta.inboundLinkCount ?? 0
  const childBlockCount = meta.childBlockCount ?? 0
  const hasTags = meta.flags?.hasTags ?? false
  const hasTodo = meta.flags?.hasTodo ?? false
  const hasScheduled = meta.flags?.hasScheduled ?? false
  const hasDue = meta.flags?.hasDue ?? false

  // PEND-56 Phase 3 — stabilise the bridging callback so `React.memo`'s
  // shallow compare on `<DensityRow>` hits across parent re-renders.
  // Without the `useCallback` the inline arrow allocated a fresh
  // function identity per render of every row, defeating the memo for
  // the entire visible list on any keystroke / star toggle. The signature
  // bridge is necessary because `DensityRowProps.onSelect` requires a
  // non-optional title while `PageBrowserRowRenderer`'s `onPageSelect`
  // is optional.
  const handleSelect = useCallback(
    (pageId: string, title: string) => onPageSelect?.(pageId, title),
    [onPageSelect],
  )

  return (
    <DensityRow
      pageId={page.id}
      title={page.content}
      filterText={trimmedFilter}
      density={density}
      virtualRowIndex={virtualRow.index}
      virtualRowStart={virtualRow.start}
      measureElement={measureElement}
      pageIndex={pageIndex}
      focusedIndex={focusedIndex}
      starred={isStarred(page.id)}
      showAliasBadge={showAliasBadge}
      deleting={deletingId === page.id}
      lastModifiedAt={lastModifiedAt}
      inboundLinkCount={inboundLinkCount}
      childBlockCount={childBlockCount}
      hasTags={hasTags}
      hasTodo={hasTodo}
      hasScheduled={hasScheduled}
      hasDue={hasDue}
      multiSelected={selectedIds.has(page.id)}
      onToggleMultiSelect={onToggleMultiSelect}
      onSelect={handleSelect}
      onToggleStar={toggleStar}
      onDeleteRequest={onDeleteRequest}
    />
  )
}

interface PageRowProps extends PageBrowserRowRendererProps {
  row: Extract<PageBrowserRow, { kind: 'page' }>
}

function PageRow({
  virtualRow,
  row,
  measureElement,
  focusedIndex,
  filterText,
  aliasMatchId,
  deletingId,
  isStarred,
  toggleStar,
  onPageSelect,
  onDeleteRequest,
  selectedIds,
  onToggleMultiSelect,
}: PageRowProps): React.ReactElement {
  const { t } = useTranslation()
  const { page, pageIndex } = row
  const pageStarred = isStarred(page.id)
  const multiSelected = selectedIds.has(page.id)
  const title = page.content ?? t('pageBrowser.untitled')
  const trimmedFilter = filterText.trim()
  const showAliasBadge =
    aliasMatchId === page.id &&
    trimmedFilter !== '' &&
    !matchesSearchFolded(page.content ?? '', trimmedFilter)
  return (
    <div
      key={virtualRow.key}
      // UX-331 — stable id so the grid container's `aria-activedescendant`
      // can point at this row when keyboard nav lands on it.
      id={`page-row-${page.id}`}
      data-index={virtualRow.index}
      ref={measureElement}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- CSS-grid row inside role="grid"; a real <tr> needs a <table> and breaks the flex layout
      role="row"
      aria-selected={focusedIndex === pageIndex}
      data-page-item
      data-starred={pageStarred}
      data-selected={multiSelected}
      tabIndex={-1}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
        // Row-highlight (background) only — the inner button paints its own
        // `focus-ring-visible` ring for the actual focus affordance.
        // Painting a ring here as well stacked two rings on the focused row.
        focusedIndex === pageIndex && 'bg-accent/30',
      )}
      style={rowStyle(virtualRow.start)}
    >
      {/* #81 / PEND-57 — batch-selection checkbox (additive to the
          single-row star/delete flow). */}
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus, jsx-a11y/prefer-tag-over-role -- gridcell focus is delegated to the inner checkbox; CSS-grid cell would break as a <td> without a <table> */}
      <div role="gridcell" className="shrink-0">
        <Checkbox
          checked={multiSelected}
          onClick={(e) => {
            e.stopPropagation()
            onToggleMultiSelect(page.id, e)
          }}
          aria-label={t('pageBrowser.select.toggle')}
          data-testid={`page-select-${page.id}`}
          className={cn(
            'shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity',
            multiSelected && 'opacity-100',
          )}
        />
      </div>
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus, jsx-a11y/prefer-tag-over-role -- gridcell focus is delegated to inner controls; CSS-grid cell would break as a <td> without a <table> */}
      <div role="gridcell" className="flex flex-1 items-center gap-3 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          aria-label={pageStarred ? t('pageBrowser.unstarPage') : t('pageBrowser.starPage')}
          className="star-toggle shrink-0 h-6 w-6 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 focus-visible:opacity-100 focus-visible:ring-inset transition-opacity text-muted-foreground hover:text-star data-[starred=true]:opacity-100 data-[starred=true]:text-star"
          data-starred={pageStarred}
          onClick={(e) => {
            e.stopPropagation()
            toggleStar(page.id)
          }}
        >
          <Star className="h-3.5 w-3.5" fill={pageStarred ? 'currentColor' : 'none'} />
        </Button>
        <button
          type="button"
          className="page-browser-item flex flex-1 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer focus-ring-visible focus-visible:ring-inset"
          onClick={() => onPageSelect?.(page.id, title)}
        >
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="page-browser-item-title truncate" title={title}>
            <HighlightMatch text={title} filterText={trimmedFilter} />
            {showAliasBadge && (
              <span className="alias-badge text-xs text-muted-foreground">(alias)</span>
            )}
          </span>
        </button>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus, jsx-a11y/prefer-tag-over-role -- gridcell focus is delegated to inner action buttons; CSS-grid cell would break as a <td> without a <table> */}
      <div role="gridcell" className="shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('pageBrowser.deleteButton')}
          className="shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 touch-target focus-visible:opacity-100 focus-visible:ring-inset transition-opacity text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
          disabled={deletingId === page.id}
          onClick={(e) => {
            e.stopPropagation()
            onDeleteRequest({ id: page.id, name: title })
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
