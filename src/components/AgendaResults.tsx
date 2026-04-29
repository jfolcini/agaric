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

import { AlertCircle } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { StatusIcon } from '@/components/ui/status-icon'
import { formatCompactDate, getTodayString } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
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
import type { BlockRow, PropertyRow } from '../lib/tauri'
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

/** Determine the color class for a due date chip based on whether it's overdue, today, or future. */
function dueDateColor(dateStr: string): string {
  const todayStr = getTodayString()
  if (dateStr < todayStr) return 'bg-destructive/10 text-destructive'
  if (dateStr === todayStr) return 'bg-status-pending text-status-pending-foreground'
  return 'bg-muted text-muted-foreground'
}

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

  const { handleBlockClick: handleItemClick, handleBlockKeyDown: handleItemKeyDown } =
    useBlockNavigation({
      onNavigateToPage,
      pageTitles,
      untitledLabel: t('agenda.untitled'),
    })

  // Shared cache for block properties — avoids redundant IPC calls across renders
  const propertiesCacheRef = useRef<Map<string, PropertyRow[]>>(new Map())

  // ── Keyboard navigation (UX-138) ────────────────────────────────────
  const listRef = useRef<HTMLDivElement>(null)

  // Apply sorting to blocks for consistent ordering (used in both flat + grouped modes)
  const sortedBlocks = useMemo(
    () => sortAgendaBlocksBy(blocks, sortBy, pageTitles),
    [blocks, sortBy, pageTitles],
  )

  // Compute groups for display (needed before flatItems)
  const groups = useMemo(() => {
    if (groupBy === 'date') return groupByDate(blocks)
    if (groupBy === 'priority') return groupByPriority(blocks)
    if (groupBy === 'state') return groupByState(blocks)
    if (groupBy === 'page') return groupByPage(sortedBlocks, pageTitles)
    return null
  }, [blocks, groupBy, sortedBlocks, pageTitles])

  const flatItems = useMemo(
    () => (groups ? groups.flatMap((g) => g.blocks) : sortedBlocks),
    [groups, sortedBlocks],
  )

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

  // Scroll focused item into view
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-block-list-item]')
    const el = items[focusedIndex] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [focusedIndex])

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
  function renderItem(block: BlockRow, currentFlatIndex: number) {
    return (
      <BlockListItem
        key={block.id}
        content={block.content}
        metadata={
          <>
            {/* Status icon */}
            <StatusIcon state={block.todo_state} />

            {/* Priority badge */}
            {block.priority && (
              <span
                className={cn(
                  'agenda-results-priority inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1',
                  priorityColor(block.priority),
                )}
              >
                P{block.priority}
              </span>
            )}

            {/* Due date chip — clickable with inline date editor */}
            <DueDateChip block={block} onDateChanged={onDateChanged} />

            {/* Dependency indicator — shows Link2 icon when blocked_by property exists */}
            <DependencyIndicator blockId={block.id} propertiesCache={propertiesCacheRef} />
          </>
        }
        pageId={block.page_id}
        pageTitle={pageTitles.get(block.page_id ?? '') ?? t('agenda.untitled')}
        breadcrumbArrow={t('agenda.breadcrumbArrow')}
        className="agenda-results-item hover:bg-accent/50 active:bg-accent/70"
        contentClassName="agenda-results-text"
        breadcrumbClassName="agenda-results-breadcrumb"
        testId="agenda-results-item"
        onClick={() => handleItemClick(block)}
        onKeyDown={(e) => handleItemKeyDown(e, block)}
        isFocused={focusedIndex === currentFlatIndex}
      />
    )
  }

  // Map group labels to i18n keys for known groups
  const GROUP_I18N: Record<string, string> = {
    Overdue: 'agenda.overdue',
    Today: 'agenda.today',
    Tomorrow: 'agenda.tomorrow',
    'No date': 'agenda.noDate',
    'No page': 'agenda.noPage',
  }

  let flatIndex = 0

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard nav container
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

      {groups ? (
        groups.map((group) => {
          const i18nKey = GROUP_I18N[group.label]
          const displayLabel = i18nKey ? t(i18nKey) : group.label
          return (
            <div key={group.label} className="agenda-group mb-3">
              <h3
                className={cn(
                  'agenda-group-header text-sm font-semibold uppercase tracking-wide px-3 py-1',
                  group.className ?? 'text-muted-foreground',
                )}
                data-testid="agenda-group-header"
              >
                {displayLabel}
                <span className="ml-1.5 text-muted-foreground font-normal">
                  ({group.blocks.length})
                </span>
              </h3>
              <ul className="agenda-results-list space-y-2" aria-label={displayLabel}>
                {group.blocks.map((block) => renderItem(block, flatIndex++))}
              </ul>
            </div>
          )
        })
      ) : (
        <ul className="agenda-results-list space-y-1" aria-label={t('agenda.agendaResults')}>
          {sortedBlocks.map((block) => renderItem(block, flatIndex++))}
        </ul>
      )}

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
  )
}
