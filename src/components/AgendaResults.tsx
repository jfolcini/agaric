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

import type React from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/EmptyState'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { StatusIcon } from '@/components/ui/status-icon'
import { formatCompactDate, getTodayString } from '@/lib/date-utils'
import { cn } from '@/lib/utils'
import { useBlockNavigation } from '../hooks/useBlockNavigation'
import {
  type AgendaSortBy,
  groupByDate,
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
  groupBy?: ('date' | 'priority' | 'state' | 'none') | undefined
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'agenda-results-due inline-flex items-center rounded-full px-2 py-0.5 text-xs [@media(pointer:coarse)]:text-sm font-medium cursor-pointer hover:ring-1 hover:ring-ring',
            dueDateColor(block.due_date),
          )}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={t('dateChip.editDate')}
        >
          {formatCompactDate(block.due_date)}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DateChipEditor
          blockId={block.id}
          dateType="due"
          currentDate={block.due_date}
          onSuccess={() => {
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
  function renderItem(block: BlockRow) {
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
        pageId={block.parent_id}
        pageTitle={pageTitles.get(block.parent_id ?? '') ?? t('agenda.untitled')}
        breadcrumbArrow={t('agenda.breadcrumbArrow')}
        className="agenda-results-item hover:bg-accent/50 active:bg-accent/70"
        contentClassName="agenda-results-text"
        breadcrumbClassName="agenda-results-breadcrumb"
        onClick={() => handleItemClick(block)}
        onKeyDown={(e) => handleItemKeyDown(e, block)}
      />
    )
  }

  // Map group labels to i18n keys for known groups
  const GROUP_I18N: Record<string, string> = {
    Overdue: 'agenda.overdue',
    Today: 'agenda.today',
    Tomorrow: 'agenda.tomorrow',
    'No date': 'agenda.noDate',
  }

  // Apply sorting to blocks for consistent ordering
  const sortedBlocks = sortAgendaBlocksBy(blocks, sortBy)

  return (
    <div className="agenda-results space-y-2">
      {/* Screen-reader result count */}
      <div role="status" className="sr-only">
        {blocks.length === 1
          ? t('agenda.resultOne')
          : t('agenda.resultCount', { count: blocks.length })}
      </div>

      {groupBy === 'date' || groupBy === 'priority' || groupBy === 'state' ? (
        (groupBy === 'date'
          ? groupByDate(blocks)
          : groupBy === 'priority'
            ? groupByPriority(blocks)
            : groupByState(blocks)
        ).map((group) => {
          const i18nKey = GROUP_I18N[group.label]
          const displayLabel = i18nKey ? t(i18nKey) : group.label
          return (
            <div key={group.label} className="agenda-group mb-3">
              <h3
                className={cn(
                  'agenda-group-header text-xs [@media(pointer:coarse)]:text-sm font-semibold uppercase tracking-wide px-3 py-1',
                  group.className ?? 'text-muted-foreground',
                )}
              >
                {displayLabel}
                <span className="ml-1.5 text-muted-foreground font-normal">
                  ({group.blocks.length})
                </span>
              </h3>
              <ul className="agenda-results-list space-y-2" aria-label={displayLabel}>
                {group.blocks.map((block) => renderItem(block))}
              </ul>
            </div>
          )
        })
      ) : (
        <ul className="agenda-results-list space-y-1" aria-label={t('agenda.agendaResults')}>
          {sortedBlocks.map((block) => renderItem(block))}
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
