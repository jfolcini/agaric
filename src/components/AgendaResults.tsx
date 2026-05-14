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
import { AlertCircle } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { StatusIcon } from '@/components/ui/status-icon'
import { BatchPropertiesProvider } from '@/hooks/useBatchProperties'
import { dueDateColor, formatCompactDate, getTodayString } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import { useBlockPropertyEvents } from '../hooks/useBlockPropertyEvents'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import {
  type AgendaSortBy,
  groupByDate,
  groupByPage,
  groupByPriority,
  groupByState,
  sortAgendaBlocksBy,
} from '../lib/agenda-sort'
import type { NavigateToPageFn } from '../lib/block-events'
import { priorityColor } from '../lib/priority-color'
import type { BlockRow } from '../lib/tauri'
import { useSpaceStore } from '../stores/space'
import { BlockListItem } from './BlockListItem'
import { DateChipEditor } from './DateChipEditor'
import { DependencyIndicator } from './DependencyIndicator'
import { LoadMoreButton } from './LoadMoreButton'

export interface AgendaResultsProps {
  /** Pre-filtered blocks to display. If empty, shows empty state. */
  blocks: BlockRow[]
  /** Whether blocks are still loading */
  loading: boolean
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

// ── Helpers ────────────────────────────────────────────────────────────

/** Whether a YYYY-MM-DD date string represents an overdue date (UX-6). */
function isOverdue(dateStr: string): boolean {
  return dateStr < getTodayString()
}

// ── Due date chip with popover ─────────────────────────────────────────

/** Inline editable due date chip — wraps the date in a Popover + DateChipEditor. */
function DueDateChip({
  block,
  onDateChanged,
}: {
  block: BlockRow
  onDateChanged?: (() => void) | undefined
}): React.ReactElement | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  if (!block.due_date) return null

  const overdue = isOverdue(block.due_date)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'agenda-results-due inline-flex items-center rounded-full px-2 py-0.5 text-xs [@media(pointer:coarse)]:text-sm [@media(pointer:coarse)]:py-1 font-medium cursor-pointer hover:ring-1 hover:ring-ring',
            dueDateColor(block.due_date),
          )}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={t('dateChip.editDate')}
        >
          {/* UX-6: surface overdue with an icon as well as a colour so colour-blind users perceive the state. */}
          {overdue && <AlertCircle className="h-3 w-3 mr-1" aria-hidden="true" />}
          {formatCompactDate(block.due_date)}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 max-w-[calc(100vw-2rem)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DateChipEditor
          blockId={block.id}
          dateType="due"
          currentDate={block.due_date}
          onSuccess={() => {
            // DateChipEditor already fires its own `toast.success` + `announce`
            // on save, so UX-4's explicit-feedback requirement is satisfied
            // without a second redundant toast here. Just close + refresh.
            setOpen(false)
            onDateChanged?.()
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

// ── Component ──────────────────────────────────────────────────────────

export function AgendaResults({
  blocks,
  loading,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
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

  // ── Loading state (initial load, no blocks yet) ────────────────────
  if (loading && blocks.length === 0) {
    return (
      <div
        className="agenda-results-loading flex items-center justify-center gap-2 py-8"
        aria-busy="true"
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
    // `useBlockNavigation` factory so `BlockListItem.memo` is not defeated by
    // fresh inline-arrow identities every render. NOTE: the inline `metadata`
    // fragment below still allocates a new React element per render, so the
    // memo will not fully hit until `BlockListItem`'s prop surface is
    // primitivized (left for a follow-up — bigger prop-shape refactor).
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
        metadata={
          <>
            {/* Status icon */}
            <StatusIcon state={block.todo_state} />

            {/* Priority badge */}
            {block.priority && (
              <span
                className={cn(
                  'agenda-results-priority inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1 [@media(pointer:coarse)]:text-sm',
                  priorityColor(block.priority),
                )}
              >
                P{block.priority}
              </span>
            )}

            {/* Due date chip — clickable with inline date editor */}
            <DueDateChip block={block} onDateChanged={onDateChanged} />

            {/* Dependency indicator — reads properties from the
                BatchPropertiesProvider mounted at the AgendaResults
                root (PEND-35 Tier 2.4a). One IPC for all rows. */}
            <DependencyIndicator blockId={block.id} />
          </>
        }
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard nav container */}
      <div
        className="agenda-results space-y-2"
        ref={listRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard nav container
        tabIndex={0}
        onKeyDown={(e) => {
          if (navHandleKeyDown(e)) e.preventDefault()
        }}
      >
        {/* Screen-reader result count */}
        <div role="status" className="sr-only">
          {blocks.length === 1
            ? t('agenda.resultOne')
            : t('agenda.resultCount', { count: blocks.length })}
        </div>

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
        <div
          ref={scrollParentRef}
          className="agenda-results-scroll max-h-[calc(100dvh-260px)] overflow-auto"
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
        </div>

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
