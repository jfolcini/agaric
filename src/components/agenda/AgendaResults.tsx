/**
 * AgendaResults -- flat results list for the agenda view (#606).
 *
 * Replaces the 3 hardcoded TaskSection panels (TODO/DOING/DONE) with a single
 * flat list of blocks. Each item shows: status icon, priority badge, due date
 * chip, content text, and a source page breadcrumb.
 *
 * This is a pure presentation component — the parent is responsible for
 * fetching, filtering, and passing down blocks.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { LoadMoreButton } from '@/components/common/LoadMoreButton'
import { BlockListItem } from '@/components/editor/BlockListItem'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { BatchPropertiesProvider } from '@/hooks/useBatchProperties'
import { useBlockNavigation } from '@/hooks/useBlockNavigation'
import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import {
  type AgendaSortBy,
  groupByDate,
  groupByPage,
  groupByPriority,
  groupByState,
  sortAgendaBlocksBy,
} from '@/lib/agenda-sort'
import type { NavigateToPageFn } from '@/lib/block-events'
import type { BlockRow } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'

export interface AgendaResultsProps {
  /** Pre-filtered blocks to display. If empty, shows empty state. */
  blocks: BlockRow[]
  /** Whether blocks are still loading */
  loading: boolean
  /**
   * Whether the initial agenda query failed (#1345). When true a distinct
   * error card with a Retry action is rendered instead of the benign
   * "No tasks found" / "No blocks match" empty state.
   */
  error?: boolean | undefined
  /** Re-run the agenda query (wired to the error card's Retry button). */
  onRetry?: (() => void) | undefined
  /** Whether more blocks can be loaded */
  hasMore: boolean
  /** Load more callback */
  onLoadMore: () => void
  /** Navigate to a block's source page */
  onNavigateToPage?: NavigateToPageFn | undefined
  /** Whether any filters are active (affects empty state messaging) */
  hasActiveFilters: boolean
  /** Clear all filters callback */
  onClearFilters: () => void
  /** Resolved page titles for breadcrumbs */
  pageTitles: Map<string, string>
  /** Group blocks by this dimension. Default: 'none'. */
  groupBy?: ('date' | 'priority' | 'state' | 'page' | 'none') | undefined
  /** Primary sort key. Default: 'date'. */
  sortBy?: AgendaSortBy | undefined
  /** Callback fired when a date is changed inline (e.g. to refresh blocks). */
  onDateChanged?: (() => void) | undefined
}

// ── Component ──────────────────────────────────────────────────────────

export function AgendaResults({
  blocks,
  loading,
  error = false,
  onRetry,
  hasMore,
  onLoadMore,
  onNavigateToPage,
  hasActiveFilters,
  onClearFilters,
  pageTitles,
  groupBy,
  sortBy = 'date',
  onDateChanged,
}: AgendaResultsProps): React.ReactElement {
  const { t } = useTranslation()

  const { handleBlockClick: handleItemClick, getRowHandlers } = useBlockNavigation({
    onNavigateToPage,
    pageTitles,
    untitledLabel: t('agenda.untitled'),
  })

  // PEND-35 Tier 2.4a: properties for every visible agenda row are
  // fetched in a single `getBatchProperties` IPC mounted via
  // `BatchPropertiesProvider` below. The previous per-row
  // `getProperties` fan-out (deduped only across re-renders, not
  // across initial mount of N rows) is gone.
  //
  // PEND-27 P6: the provider re-fetches whenever
  // `useBlockPropertyEvents().invalidationKey` bumps OR the active
  // space switches, so the dependency indicator reflects fresh data
  // after edits. We pass a stable composite key into the provider
  // rather than driving a separate cache-clear effect.
  const { invalidationKey: propertyInvalidationKey } = useBlockPropertyEvents()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const batchInvalidationKey = `${propertyInvalidationKey}|${currentSpaceId ?? ''}`

  // ── Keyboard navigation (UX-138) ────────────────────────────────────
  const listRef = useRef<HTMLDivElement>(null)
  // perf-review Tier 2 #6 (2026-05-14) — scroll container ref for the
  // virtualizer. Distinct from `listRef` (the keyboard-nav container
  // that holds the result-count `role="status"` and the
  // `LoadMoreButton`); the virtualizer needs to scroll the inner
  // flat-row container, while keyboard arrow keys still target the
  // outer `listRef`.
  const scrollParentRef = useRef<HTMLDivElement>(null)

  // Sort once for the flat (no-group) display path. The grouping helpers
  // (groupByDate / groupByPriority / groupByState / groupByPage) all re-sort
  // internally with their own group-specific key chains, so feeding them a
  // pre-sorted list would just be thrown away. Per FE-M-9 we picked option
  // (a) — keep the helpers' internal sort and feed every grouping branch
  // raw `blocks` — because option (b) would require changing helper sort
  // behaviour, which the task forbids. `sortedBlocks` is therefore consumed
  // only by the flat fallback below.
  const sortedBlocks = useMemo(
    () => sortAgendaBlocksBy(blocks, sortBy, pageTitles),
    [blocks, sortBy, pageTitles],
  )

  // Compute groups for display (needed before flatItems)
  const groups = useMemo(() => {
    if (groupBy === 'date') return groupByDate(blocks)
    if (groupBy === 'priority') return groupByPriority(blocks)
    if (groupBy === 'state') return groupByState(blocks)
    if (groupBy === 'page') return groupByPage(blocks, pageTitles)
    return null
  }, [blocks, groupBy, pageTitles])

  const flatItems = useMemo(
    () => (groups ? groups.flatMap((g) => g.blocks) : sortedBlocks),
    [groups, sortedBlocks],
  )

  // Stable list of block IDs for the BatchPropertiesProvider. The
  // provider derives a sorted membership key internally so a new array
  // reference with identical contents does NOT trigger a refetch.
  const allBlockIds = useMemo(() => blocks.map((b) => b.id), [blocks])

  const {
    focusedIndex,
    setFocusedIndex,
    handleKeyDown: navHandleKeyDown,
  } = useListKeyboardNavigation({
    itemCount: flatItems.length,
    homeEnd: true,
    pageUpDown: true,
    onSelect: (idx) => {
      const block = flatItems[idx]
      if (block) handleItemClick(block)
    },
  })

  // Reset focused index when blocks / sort / group change
  useEffect(() => {
    setFocusedIndex(0)
  }, [blocks, sortBy, groupBy, setFocusedIndex])

  // ── Virtualization (perf-review Tier 2 #6, 2026-05-14) ─────────────
  // Map group labels to i18n keys for known groups. Hoisted above the
  // virtual-row builder so both the keyboard-driven scroll-into-view
  // effect and the grouped render path consume the same source.
  const GROUP_I18N: Record<string, string> = useMemo(
    () => ({
      Overdue: 'agenda.overdue',
      Today: 'agenda.today',
      Tomorrow: 'agenda.tomorrow',
      'No date': 'agenda.noDate',
      'No page': 'agenda.noPage',
    }),
    [],
  )

  // Build the flat row list consumed by the virtualizer. When grouped,
  // a `group-header` row is interspersed before each group's items so
  // the virtualizer treats headers and items as siblings and can skip
  // the entire offscreen tree. The `flatItemIndex` field threads each
  // item row back to the `flatItems` array so keyboard-nav focus
  // mapping (`focusedIndex` indexes `flatItems`) stays correct.
  type VirtualRow =
    | {
        kind: 'group-header'
        key: string
        label: string
        count: number
        className: string | undefined
      }
    | { kind: 'item'; key: string; block: BlockRow; flatItemIndex: number }

  const virtualRows = useMemo<VirtualRow[]>(() => {
    if (!groups) {
      return sortedBlocks.map((block, idx) => ({
        kind: 'item' as const,
        key: block.id,
        block,
        flatItemIndex: idx,
      }))
    }
    const rows: VirtualRow[] = []
    let flatIdx = 0
    for (const group of groups) {
      const i18nKey = GROUP_I18N[group.label]
      const displayLabel = i18nKey ? t(i18nKey) : group.label
      rows.push({
        kind: 'group-header',
        key: `header:${group.label}`,
        label: displayLabel,
        count: group.blocks.length,
        className: group.className,
      })
      for (const block of group.blocks) {
        rows.push({
          kind: 'item',
          key: block.id,
          block,
          flatItemIndex: flatIdx++,
        })
      }
    }
    return rows
  }, [groups, sortedBlocks, GROUP_I18N, t])

  // PEND-30 L-5 style: stable estimateSize identity so option-identity
  // changes don't trigger a re-measure when `virtualRows` is unchanged.
  // Header rows are ~36px (`px-3 py-1` + sm text); item rows render a
  // `BlockListItem` whose default touch min-height is 44px, but with
  // metadata + breadcrumb gap the typical observed height is ~56px.
  // `measureElement` corrects to actual height after first paint.
  const estimateSize = useCallback(
    (index: number) => {
      const row = virtualRows[index]
      if (row?.kind === 'group-header') return 36
      return 56
    },
    [virtualRows],
  )

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize,
    overscan: 5,
    getItemKey: (index) => virtualRows[index]?.key ?? index,
  })

  // Scroll focused item into view via the virtualizer. `focusedIndex`
  // indexes `flatItems` (the items-only array used by keyboard nav);
  // map it to the virtual-row index so headers don't shift the count.
  const flatToVirtualIndex = useMemo(() => {
    const map: number[] = []
    virtualRows.forEach((row, idx) => {
      if (row.kind === 'item') map[row.flatItemIndex] = idx
    })
    return map
  }, [virtualRows])

  useEffect(() => {
    if (focusedIndex < 0) return
    const idx = flatToVirtualIndex[focusedIndex]
    if (idx == null) return
    virtualizer.scrollToIndex(idx, { align: 'auto' })
  }, [focusedIndex, virtualizer, flatToVirtualIndex])

  // ── Error state (#1345) ────────────────────────────────────────────
  // The initial agenda query failed. Render a distinct, retryable error
  // card instead of the benign empty state so a backend failure is not
  // mistaken for an empty agenda. Mirrors the SearchPanel error card
  // (role="alert" + destructive-tinted card) and adds a Retry action.
  // Takes precedence over loading/empty so the failure isn't masked by a
  // stale skeleton.
  if (error && !loading) {
    return (
      <div
        role="alert"
        data-testid="agenda-error-state"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <p className="font-medium">{t('agenda.loadFailed')}</p>
        <p className="text-destructive/90">{t('agenda.loadFailedBody')}</p>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="mt-3"
            data-testid="agenda-error-retry"
          >
            {t('action.retry')}
          </Button>
        )}
      </div>
    )
  }

  // ── Loading state (initial load, no blocks yet) ────────────────────
  if (loading && blocks.length === 0) {
    return (
      <div
        className="agenda-results-loading flex items-center justify-center gap-2 py-8"
        aria-busy="true"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> defaults to display:inline and would break this flex centering container; keep role="status" on the div
        role="status"
      >
        <LoadingSkeleton count={3} height="h-10" />
      </div>
    )
  }

  // ── Empty states ───────────────────────────────────────────────────
  if (blocks.length === 0) {
    if (hasActiveFilters) {
      return (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> only permits phrasing content; this wraps the block-level <EmptyState>, so keep role="status" on the div
        <div role="status">
          <EmptyState
            message={t('agenda.noMatch')}
            action={
              <Button variant="outline" size="sm" onClick={onClearFilters} className="mt-2">
                {t('agenda.clearFilters')}
              </Button>
            }
          />
        </div>
      )
    }
    return (
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- <output> only permits phrasing content; this wraps the block-level <EmptyState>, so keep role="status" on the div
      <div role="status">
        <EmptyState message={t('agenda.noTasks')} />
      </div>
    )
  }

  // ── Results list ───────────────────────────────────────────────────

  /** Render a single agenda item (shared between flat and grouped modes). */
  function renderItem(
    block: BlockRow,
    currentFlatIndex: number,
    virtualRow: { key: React.Key; index: number; start: number },
  ) {
    // Tier 1.4 (perf-review 2026-05-09): stable per-block handlers from the
    // `useBlockNavigation` factory + typed primitive metadata props so
    // `BlockListItem.memo` shallow-compare hits cleanly across parent
    // re-renders (perf-review 2026-05-14 follow-up).
    const rowHandlers = getRowHandlers(block)
    return (
      <BlockListItem
        key={virtualRow.key}
        liRef={virtualizer.measureElement}
        dataIndex={virtualRow.index}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${virtualRow.start}px)`,
        }}
        content={block.content}
        // Metadata primitives — rendered by `BlockListItem`'s internal
        // `BlockMetadataRow` sub-component (memoed) so a parent re-render
        // without prop changes does NOT allocate fresh React elements per row.
        statusIconState={block.todo_state}
        priority={block.priority}
        priorityVariant="agenda"
        dueDate={block.due_date}
        dueDateBlockId={block.id}
        {...(onDateChanged !== undefined && { onDateChanged })}
        dependencyBlockId={block.id}
        pageId={block.page_id}
        pageTitle={pageTitles.get(block.page_id ?? '') ?? t('agenda.untitled')}
        breadcrumbArrow={t('agenda.breadcrumbArrow')}
        className="agenda-results-item hover:bg-accent/50 active:bg-accent/70"
        contentClassName="agenda-results-text"
        breadcrumbClassName="agenda-results-breadcrumb"
        testId="agenda-results-item"
        onClick={rowHandlers.onClick}
        onKeyDown={rowHandlers.onKeyDown}
        isFocused={focusedIndex === currentFlatIndex}
      />
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <BatchPropertiesProvider blockIds={allBlockIds} invalidationKey={batchInvalidationKey}>
      {/* #1520 — roving tabindex: the focused `BlockListItem` row is the
          single tab stop (others are `tabIndex=-1`), so the container must NOT
          carry `tabIndex={0}` or the list would have a doubled keyboard model.
          The arrow-key handler stays here and fires via keydown bubbling from
          the focused row. */}
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keyboard nav container (events bubble from the roving row); not itself focusable */}
      <div
        className="agenda-results space-y-2"
        ref={listRef}
        onKeyDown={(e) => {
          if (navHandleKeyDown(e)) e.preventDefault()
        }}
      >
        {/* Screen-reader result count */}
        <output className="sr-only">
          {blocks.length === 1
            ? t('agenda.resultOne')
            : t('agenda.resultCount', { count: blocks.length })}
        </output>

        {/* Virtualized list (perf-review Tier 2 #6, 2026-05-14).
            Headers + items are interleaved as flat virtual rows so the
            virtualizer can drop offscreen subtrees entirely; this
            replaces the previous nested `groups.map(group => group.blocks.map(item))`
            tree-walk.

            `BlockListItem` renders an `<li>` directly, so each virtual
            row uses `<li>` (item rows) or `<li role="presentation">`
            (group-header rows) under a single `<ul>` parent. This
            keeps the listitem axe rule happy in both flat and grouped
            modes without re-wrapping `BlockListItem` in an extra `<li>`
            (which would also have failed the rule for nested `<li>`s). */}
        <ScrollArea
          viewportRef={scrollParentRef}
          // pr-2.5 reserves room for the classic 10px scrollbar gutter so a
          // focused/selected row's full rounded border (the right side in
          // particular) renders inside the viewport instead of being clipped
          // under the scrollbar. The `<ul>` is a block child of the viewport,
          // so this right padding narrows the `width:100%` absolute rows with
          // it — keeping all four border sides visible.
          viewportClassName="agenda-results-scroll max-h-[calc(100dvh-260px)] pr-2.5"
        >
          <ul
            className="agenda-results-list relative m-0 p-0 list-none"
            aria-label={t('agenda.agendaResults')}
            style={{ height: `${totalSize}px` }}
          >
            {virtualItems.map((virtualRow) => {
              const row = virtualRows[virtualRow.index]
              if (!row) return null
              const rowStyle: React.CSSProperties = {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }
              if (row.kind === 'group-header') {
                return (
                  // Group headers ride a `<li>` so they're a valid
                  // child of the surrounding `<ul>` (axe's `list` rule
                  // rejects non-`<li>` children, and `role="presentation"`
                  // on the `<li>` would also fail because it strips
                  // the listitem role — see the inline `<h3>` below
                  // which is what screen readers should land on).
                  <li
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={rowStyle}
                    className="agenda-group"
                  >
                    <h3
                      className={cn(
                        'agenda-group-header text-sm font-semibold uppercase tracking-wide px-3 py-1',
                        row.className ?? 'text-muted-foreground',
                      )}
                      data-testid="agenda-group-header"
                    >
                      {row.label}
                      <span className="ml-1.5 text-muted-foreground font-normal">
                        ({row.count})
                      </span>
                    </h3>
                  </li>
                )
              }
              // `BlockListItem` IS a `<li>`. Pass the virtualizer's
              // positioning style + ref + data-index through `liRef` /
              // `style` / `dataIndex` so the row is a direct child of
              // the `<ul>` (no nested-`<li>` HTML violation, exactly
              // one listitem-roled element per row).
              return renderItem(row.block, row.flatItemIndex, virtualRow)
            })}
          </ul>
        </ScrollArea>

        {/* Load more */}
        <LoadMoreButton
          hasMore={hasMore}
          loading={loading}
          onLoadMore={onLoadMore}
          className="agenda-results-load-more mt-2"
          label={t('agenda.loadMore')}
          loadingLabel={t('agenda.loading')}
          ariaLabel={t('agenda.loadMoreLabel')}
          ariaLoadingLabel={t('agenda.loadingMore')}
        />
      </div>
    </BatchPropertiesProvider>
  )
}
