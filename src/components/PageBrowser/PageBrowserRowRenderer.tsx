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
import { useTranslation } from 'react-i18next'
import { HighlightMatch } from '@/components/HighlightMatch'
import { PageTreeItem } from '@/components/PageTreeItem'
import { Button } from '@/components/ui/button'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { cn } from '@/lib/utils'
import type { PageBrowserRow } from '../../hooks/usePageBrowserGrouping'

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
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid row for section header — no semantic HTML equivalent for non-tabular grouped lists
    // biome-ignore lint/a11y/useFocusableInteractive: section header row is not interactive
    <div
      key={virtualRow.key}
      data-index={virtualRow.index}
      ref={measureElement}
      data-page-section={row.section}
      role="row"
      aria-labelledby={labelId}
      className={cn('page-browser-section', showDivider && 'border-t border-border mt-1')}
      style={rowStyle(virtualRow.start)}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: ARIA gridcell for grid pattern */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: gridcell carries the section label — not interactive */}
      <div
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
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid row — no semantic HTML equivalent for nested-action rows
    // biome-ignore lint/a11y/useFocusableInteractive: row focus is delegated to inner button controls
    <div
      key={virtualRow.key}
      data-index={virtualRow.index}
      ref={measureElement}
      data-page-tree-row
      data-page-index={pageIndex}
      role="row"
      className={cn(
        focusedIndex === pageIndex && 'rounded-lg ring-2 ring-inset ring-ring/50 bg-accent/30',
      )}
      style={rowStyle(virtualRow.start)}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: ARIA gridcell for grid pattern */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: gridcell focus is delegated to inner button controls */}
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
}: PageRowProps): React.ReactElement {
  const { t } = useTranslation()
  const { page, pageIndex } = row
  const pageStarred = isStarred(page.id)
  const title = page.content ?? t('pageBrowser.untitled')
  const trimmedFilter = filterText.trim()
  const showAliasBadge =
    aliasMatchId === page.id &&
    trimmedFilter !== '' &&
    !matchesSearchFolded(page.content ?? '', trimmedFilter)
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid row — no semantic HTML equivalent for nested-action rows
    <div
      key={virtualRow.key}
      data-index={virtualRow.index}
      ref={measureElement}
      role="row"
      aria-selected={focusedIndex === pageIndex}
      data-page-item
      data-starred={pageStarred}
      tabIndex={-1}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
        // Row-highlight (background) only — the inner button paints its own
        // `focus-visible:ring-[3px]` ring for the actual focus affordance.
        // Painting a ring here as well stacked two rings on the focused row.
        focusedIndex === pageIndex && 'bg-accent/30',
      )}
      style={rowStyle(virtualRow.start)}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: ARIA gridcell for grid pattern */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: gridcell focus is delegated to inner controls */}
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
          className="page-browser-item flex flex-1 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 focus-visible:outline-hidden"
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
      {/* biome-ignore lint/a11y/useSemanticElements: ARIA gridcell for grid pattern */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: gridcell focus is delegated to inner action buttons */}
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
