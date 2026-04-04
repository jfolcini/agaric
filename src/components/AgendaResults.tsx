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

import { CheckCircle2, Circle, Clock, Loader2 } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  type AgendaSortBy,
  groupByDate,
  groupByPriority,
  groupByState,
  sortAgendaBlocksBy,
} from '../lib/agenda-sort'
import { priorityColor } from '../lib/priority-color'
import type { BlockRow } from '../lib/tauri'

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
  onNavigateToPage?: ((pageId: string, title: string, blockId?: string) => void) | undefined
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
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Short month names for compact date display. */
const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Format a YYYY-MM-DD date string compactly. Same year -> "Apr 15", different year -> "Apr 15, 2025". */
function formatCompactDate(dateStr: string): string {
  const parts = dateStr.split('-')
  if (parts.length !== 3) return dateStr
  const [y, m, d] = parts.map(Number)
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return dateStr
  const month = MONTH_SHORT[(m ?? 1) - 1] ?? 'Jan'
  const day = d ?? 1
  const now = new Date()
  if (y === now.getFullYear()) return `${month} ${day}`
  return `${month} ${day}, ${y}`
}

/** Determine the color class for a due date chip based on whether it's overdue, today, or future. */
function dueDateColor(dateStr: string): string {
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (dateStr < todayStr) return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
  if (dateStr === todayStr)
    return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
  return 'bg-muted text-muted-foreground'
}

/** Truncate content to plain text. */
function truncateContent(content: string | null, max = 120): string {
  if (!content) return '(empty)'
  const plain = content.replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/[#*_~`]/g, '')
  return plain.length > max ? `${plain.slice(0, max)}...` : plain
}

/** Return the appropriate status icon component for a todo_state. */
function StatusIcon({ state }: { state: string | null }): React.ReactElement {
  if (state === 'DOING')
    return (
      <Clock
        className="h-4 w-4 shrink-0 text-blue-500"
        aria-hidden="true"
        data-testid="icon-doing"
      />
    )
  if (state === 'DONE')
    return (
      <CheckCircle2
        className="h-4 w-4 shrink-0 text-green-600"
        aria-hidden="true"
        data-testid="icon-done"
      />
    )
  // Default: TODO or unknown
  return (
    <Circle
      className="h-4 w-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
      data-testid="icon-todo"
    />
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
}: AgendaResultsProps): React.ReactElement {
  const { t } = useTranslation()

  const handleItemClick = useCallback(
    (block: BlockRow) => {
      if (block.parent_id && onNavigateToPage) {
        const title = pageTitles.get(block.parent_id) ?? t('agenda.untitled')
        onNavigateToPage(block.parent_id, title, block.id)
      }
    },
    [onNavigateToPage, pageTitles, t],
  )

  const handleItemKeyDown = useCallback(
    (e: React.KeyboardEvent, block: BlockRow) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleItemClick(block)
      }
    },
    [handleItemClick],
  )

  // ── Loading state (initial load, no blocks yet) ────────────────────
  if (loading && blocks.length === 0) {
    return (
      <div
        className="agenda-results-loading flex items-center justify-center gap-2 py-8"
        aria-busy="true"
        role="status"
      >
        <Loader2 className="h-5 w-5 animate-spin" data-testid="loader-spinner" />
        <span className="text-sm text-muted-foreground">{t('agenda.loadingTasks')}</span>
      </div>
    )
  }

  // ── Empty states ───────────────────────────────────────────────────
  if (blocks.length === 0) {
    if (hasActiveFilters) {
      return (
        <div className="agenda-results-empty flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-sm text-muted-foreground">{t('agenda.noMatch')}</p>
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            {t('agenda.clearFilters')}
          </Button>
          <div role="status" className="sr-only">
            {t('agenda.zeroResults')}
          </div>
        </div>
      )
    }
    return (
      <div className="agenda-results-empty flex flex-col items-center gap-2 py-8 text-center">
        <p className="text-sm text-muted-foreground">{t('agenda.noTasks')}</p>
        <div role="status" className="sr-only">
          {t('agenda.zeroResults')}
        </div>
      </div>
    )
  }

  // ── Results list ───────────────────────────────────────────────────

  /** Render a single agenda item (shared between flat and grouped modes). */
  function renderItem(block: BlockRow) {
    return (
      <li
        key={block.id}
        className="agenda-results-item flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer hover:bg-accent/50 transition-colors"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
        tabIndex={0}
        onClick={() => handleItemClick(block)}
        onKeyDown={(e) => handleItemKeyDown(e, block)}
      >
        {/* Status icon */}
        <StatusIcon state={block.todo_state} />

        {/* Priority badge */}
        {block.priority && (
          <span
            className={cn(
              'agenda-results-priority inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1',
              priorityColor(block.priority),
            )}
          >
            P{block.priority}
          </span>
        )}

        {/* Due date chip */}
        {block.due_date && (
          <span
            className={cn(
              'agenda-results-due inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
              dueDateColor(block.due_date),
            )}
          >
            {formatCompactDate(block.due_date)}
          </span>
        )}

        {/* Block content */}
        <span className="agenda-results-text flex-1 truncate text-sm">
          {truncateContent(block.content)}
        </span>

        {/* Source page breadcrumb */}
        {block.parent_id && (
          <span className="agenda-results-breadcrumb text-xs text-muted-foreground shrink-0">
            &rarr; {pageTitles.get(block.parent_id) ?? t('agenda.untitled')}
          </span>
        )}
      </li>
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
    <div className="agenda-results space-y-1">
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
                  'agenda-group-header text-xs font-semibold uppercase tracking-wide px-2 py-1',
                  group.className ?? 'text-muted-foreground',
                )}
              >
                {displayLabel}
                <span className="ml-1.5 text-muted-foreground font-normal">
                  ({group.blocks.length})
                </span>
              </h3>
              <ul className="agenda-results-list space-y-1" aria-label={displayLabel}>
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
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="agenda-results-load-more w-full mt-2"
          onClick={onLoadMore}
          disabled={loading}
          aria-busy={loading}
          aria-label={loading ? t('agenda.loadingMore') : t('agenda.loadMoreLabel')}
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" data-testid="loader-spinner" />{' '}
              {t('agenda.loading')}
            </>
          ) : (
            t('agenda.loadMore')
          )}
        </Button>
      )}
    </div>
  )
}
