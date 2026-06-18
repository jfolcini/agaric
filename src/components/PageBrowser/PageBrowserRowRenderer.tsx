/**
 * PageBrowserRowRenderer — renders a single row inside the `PageBrowser`
 * virtualizer. Dispatches on `row.kind` to one of the three internal
 * sub-renderers (header / page / tree-page). All state is passed in as
 * props — this sibling is presentational and stateless.
 *
 * Extracted from `PageBrowser.tsx` (MAINT-128).
 */

import type { VirtualItem } from '@tanstack/react-virtual'
import { FileText, Star } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { PageTreeItem } from '@/components/pages/PageTreeItem'
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
   * PEND-56 Phase 3 — active density mode for the `<DensityRow>` body.
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
  // PEND-56 Phase 3 — leaf `page` rows render via `<DensityRow>`
  // (metadata-aware, density-aware). The density-aware row reads its
  // metadata via a cast through `PageWithMetadataRow` (the IPC payload
  // is a structural superset).
  return <DensityPageRow {...props} row={row} />
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
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell focus is delegated to inner button controls; CSS-grid cell would break as a <td> without a <table> */}
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
 * to it) but the underlying payload is actually a `PageWithMetadataRow`
 * (from `listPagesWithMetadata`). The two share the `id` / `content`
 * columns by structural overlap, and the metadata
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

  // The grouping hook normalises the payload to `BlockRow`; the row
  // object is actually a `PageWithMetadataRow` with the metadata columns
  // set. Optimistic inserts from the create form are still raw
  // `BlockRow`s — `?? 0` / `?? false` keeps them safe.
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
