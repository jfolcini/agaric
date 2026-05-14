/**
 * BlockListItem — shared presentational component for rendering a block
 * in list views (DuePanel, DonePanel, AgendaResults).
 *
 * Renders a clickable `<li>` with a consistent layout:
 *   [metadata row] → [truncated content] → [page breadcrumb]
 *
 * The metadata row is rendered from typed primitive props
 * (`statusIconState`, `priority`, `dueDate`, `dependencyBlockId`,
 * `showCompletedIcon`) so that `React.memo` shallow-compare can hit
 * across parent re-renders.
 *
 * The legacy `metadata?: ReactNode` slot is retained as a deprecated
 * escape hatch for one-off content (e.g. `UnfinishedTasks` composing a
 * due/scheduled pill) that can't be modeled as primitives. Inline JSX
 * passed through `metadata` always allocates a fresh React element per
 * render and therefore defeats `BlockListItem.memo`; prefer the
 * primitive props for all new callsites (perf-review Tier 1.4).
 */

import { AlertCircle, CalendarDays, CheckCircle2 } from 'lucide-react'
import type React from 'react'
import { memo, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useBlockReschedule } from '../hooks/useBlockReschedule'
import { useRichContentCallbacks, useTagClickHandler } from '../hooks/useRichContentCallbacks'
import { announce } from '../lib/announcer'
import { dueDateColor, formatCompactDate, formatDate, getTodayString } from '../lib/date-utils'
import { priorityColor } from '../lib/priority-color'
import { reportIpcError } from '../lib/report-ipc-error'
import { DateChipEditor } from './DateChipEditor'
import { DependencyIndicator } from './DependencyIndicator'
import { PageLink } from './PageLink'
import { renderRichContent } from './RichContentRenderer'
import { Calendar } from './ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { PriorityBadge } from './ui/priority-badge'
import { StatusIcon } from './ui/status-icon'

/** Variant of the priority badge rendering used in the metadata row. */
export type PriorityBadgeVariant = 'default' | 'agenda'

// ── Inline editable due date chip ─────────────────────────────────────
// Wraps a date string in a Popover + DateChipEditor so callers can pick
// a new due date inline without leaving the list view. Lifted from
// `AgendaResults` so `BlockListItem` can render the chip directly from
// the `dueDate` primitive prop instead of accepting it as inline JSX
// (perf-review Tier 1.4 metadata half, 2026-05-14).

interface DueDateChipProps {
  blockId: string | null | undefined
  dueDate: string
  onDateChanged: (() => void) | undefined
}

function isOverdue(dateStr: string): boolean {
  return dateStr < getTodayString()
}

function DueDateChipInner({
  blockId,
  dueDate,
  onDateChanged,
}: DueDateChipProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const overdue = isOverdue(dueDate)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'agenda-results-due inline-flex items-center rounded-full px-2 py-0.5 text-xs [@media(pointer:coarse)]:text-sm [@media(pointer:coarse)]:py-1 font-medium cursor-pointer hover:ring-1 hover:ring-ring',
            dueDateColor(dueDate),
          )}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={t('dateChip.editDate')}
        >
          {/* UX-6: surface overdue with an icon as well as a colour so colour-blind users perceive the state. */}
          {overdue && <AlertCircle className="h-3 w-3 mr-1" aria-hidden="true" />}
          {formatCompactDate(dueDate)}
        </button>
      </PopoverTrigger>
      {blockId && (
        <PopoverContent
          align="start"
          className="w-64 max-w-[calc(100vw-2rem)]"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <DateChipEditor
            blockId={blockId}
            dateType="due"
            currentDate={dueDate}
            onSuccess={() => {
              // DateChipEditor already fires its own `toast.success` + `announce`
              // on save, so UX-4's explicit-feedback requirement is satisfied
              // without a second redundant toast here. Just close + refresh.
              setOpen(false)
              onDateChanged?.()
            }}
          />
        </PopoverContent>
      )}
    </Popover>
  )
}

const DueDateChip = memo(DueDateChipInner)
DueDateChip.displayName = 'DueDateChip'

// ── Metadata row sub-component ────────────────────────────────────────
// Renders the leading icons / badges / chips from typed primitive props
// so `React.memo` on `BlockListItem` can shallow-compare metadata props
// instead of always-fresh ReactNode references.

interface BlockMetadataRowProps {
  dueDateBlockId: string | null | undefined
  statusIconState: string | null | undefined
  statusIconShowDone: boolean | undefined
  priority: string | null | undefined
  priorityVariant: PriorityBadgeVariant | undefined
  priorityBadgeClassName: string | undefined
  dueDate: string | null | undefined
  onDateChanged: (() => void) | undefined
  showCompletedIcon: boolean | undefined
  completedIconClassName: string | undefined
  dependencyBlockId: string | undefined
}

function BlockMetadataRowInner({
  dueDateBlockId,
  statusIconState,
  statusIconShowDone,
  priority,
  priorityVariant = 'default',
  priorityBadgeClassName,
  dueDate,
  onDateChanged,
  showCompletedIcon,
  completedIconClassName,
  dependencyBlockId,
}: BlockMetadataRowProps): React.ReactElement | null {
  // Bail out cheaply when no metadata is requested at all (DonePanel
  // without showCompletedIcon, etc.) so we don't emit phantom DOM.
  if (
    statusIconState === undefined &&
    (priority == null || priority === '') &&
    !dueDate &&
    !showCompletedIcon &&
    !dependencyBlockId
  ) {
    return null
  }

  return (
    <>
      {statusIconState !== undefined && (
        <StatusIcon
          state={statusIconState}
          {...(statusIconShowDone !== undefined && { showDone: statusIconShowDone })}
        />
      )}

      {showCompletedIcon && (
        <CheckCircle2
          className={cn('h-4 w-4 shrink-0 text-status-done-foreground', completedIconClassName)}
          aria-hidden="true"
          data-testid="check-circle"
        />
      )}

      {priority != null && priority !== '' && priorityVariant === 'agenda' && (
        <span
          className={cn(
            'agenda-results-priority inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold [@media(pointer:coarse)]:px-2.5 [@media(pointer:coarse)]:py-1 [@media(pointer:coarse)]:text-sm',
            priorityColor(priority),
            priorityBadgeClassName,
          )}
        >
          P{priority}
        </span>
      )}

      {priority != null && priority !== '' && priorityVariant === 'default' && (
        <PriorityBadge
          priority={priority}
          {...(priorityBadgeClassName !== undefined && { className: priorityBadgeClassName })}
        />
      )}

      {dueDate && (
        <DueDateChip blockId={dueDateBlockId} dueDate={dueDate} onDateChanged={onDateChanged} />
      )}

      {dependencyBlockId && <DependencyIndicator blockId={dependencyBlockId} />}
    </>
  )
}

const BlockMetadataRow = memo(BlockMetadataRowInner)
BlockMetadataRow.displayName = 'BlockMetadataRow'

// ── BlockListItem ──────────────────────────────────────────────────────

export interface BlockListItemProps {
  /** Block content text — truncated via CSS line-clamp. */
  content: string | null
  /** Max characters before truncation. Default 120. */
  contentMaxLength?: number
  /** Fallback text when content is null/empty. Defaults to the localized "(empty)" string. */
  emptyContentFallback?: string
  /**
   * @deprecated Escape hatch for callers that need one-off metadata JSX
   * (e.g. `UnfinishedTasks`'s combined due-or-scheduled pill). Prefer the
   * typed primitive props below — passing inline JSX here allocates a
   * fresh React element every parent render and defeats
   * `BlockListItem.memo`'s shallow compare (perf-review Tier 1.4).
   */
  metadata?: React.ReactNode

  // ── Typed metadata primitives (perf-review Tier 1.4 metadata half) ──

  /**
   * Status icon state (e.g. `'TODO'`, `'DOING'`, `'DONE'`, `'CANCELLED'`).
   * Pass `null` to render the default TODO circle; omit to skip entirely.
   */
  statusIconState?: string | null
  /** Whether the DONE state status icon is shown. Default `true`. */
  statusIconShowDone?: boolean
  /** Priority string ('1' / '2' / '3' / custom). Omit / null / empty to skip. */
  priority?: string | null
  /** Priority badge rendering variant. `'default'` uses `PriorityBadge`;
   * `'agenda'` uses the legacy `agenda-results-priority` layout. */
  priorityVariant?: PriorityBadgeVariant
  /** Extra classes for the priority badge wrapper. */
  priorityBadgeClassName?: string
  /** Due date chip — ISO YYYY-MM-DD. Omit / null / empty to skip. */
  dueDate?: string | null
  /**
   * Block ID for the inline due-date editor (rendered when `dueDate` is
   * set). Separate from the outer `blockId` prop so callers can render
   * an editable date chip without opting into HTML5 drag + the
   * touch-only reschedule button (e.g. `AgendaResults`).
   */
  dueDateBlockId?: string | null
  /** Callback fired after the inline due-date editor saves. */
  onDateChanged?: () => void
  /** When `true`, renders a leading `CheckCircle2` icon (DonePanel). */
  showCompletedIcon?: boolean
  /** Extra classes for the completion icon. */
  completedIconClassName?: string
  /** When set, mounts a `DependencyIndicator` for this block id. */
  dependencyBlockId?: string

  /** Page ID for the breadcrumb. Hidden when nullish. */
  pageId?: string | null
  /** Page title shown in breadcrumb. */
  pageTitle?: string
  /** Arrow text before page title (e.g. "→"). Default "→". */
  breadcrumbArrow?: string
  /** Render breadcrumb title as a PageLink (true) or plain text (false). Default true. */
  breadcrumbAsLink?: boolean
  /** Click handler for the list item. */
  onClick?: () => void
  /** Keyboard handler for the list item. */
  onKeyDown?: (e: React.KeyboardEvent) => void
  /** Additional CSS classes appended to the `<li>`. */
  className?: string
  /** Additional CSS classes for the content `<span>`. */
  contentClassName?: string
  /** Additional CSS classes for the breadcrumb `<span>`. */
  breadcrumbClassName?: string
  /** data-testid for the `<li>`. */
  testId?: string
  /** Block ID — when provided, enables native HTML5 drag for rescheduling (F-32). */
  blockId?: string
  /** Callback fired after rescheduling a block via the touch calendar popover. */
  onReschedule?: (blockId: string, newDate: string) => void
  /** Whether this item is focused via keyboard navigation. */
  isFocused?: boolean
  /**
   * Optional inline `style` (perf-review Tier 2 #6, 2026-05-14) —
   * `@tanstack/react-virtual` consumers (AgendaResults, HistoryListView,
   * DonePanel, DuePanel) need to apply `position: absolute` +
   * `transform: translateY(...)` directly on the row's `<li>` so each
   * virtual row keeps a single listitem-roled element (wrapping
   * `BlockListItem` in another `<li>` would emit invalid nested-`<li>`
   * HTML; wrapping in a `<div>` would lose the listitem role queried by
   * tests via `getAllByRole('listitem')`).
   */
  style?: React.CSSProperties
  /** Optional `ref` forwarded to the `<li>` so the virtualizer can call `measureElement`. */
  liRef?: (node: HTMLLIElement | null) => void
  /** Forwarded `data-index` so the virtualizer can identify the row when measuring. */
  dataIndex?: number
}

function BlockListItemInner({
  content,
  contentMaxLength: _contentMaxLength = 120,
  emptyContentFallback,
  metadata,
  statusIconState,
  statusIconShowDone,
  priority,
  priorityVariant,
  priorityBadgeClassName,
  dueDate,
  dueDateBlockId,
  onDateChanged,
  showCompletedIcon,
  completedIconClassName,
  dependencyBlockId,
  pageId,
  pageTitle = '',
  breadcrumbArrow = '→',
  breadcrumbAsLink = true,
  onClick,
  onKeyDown,
  className,
  contentClassName,
  breadcrumbClassName,
  testId,
  blockId,
  onReschedule,
  isFocused,
  style,
  liRef,
  dataIndex,
}: BlockListItemProps): React.ReactElement {
  const { t } = useTranslation()
  const callbacks = useRichContentCallbacks()
  const onTagClick = useTagClickHandler()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const { reschedule } = useBlockReschedule()

  // biome-ignore lint/correctness/useExhaustiveDependencies: callbacks are stable (ref-backed) — only content drives the rendered output
  const richContent = useMemo(
    () =>
      content ? renderRichContent(content, { interactive: true, onTagClick, ...callbacks }) : null,
    [content],
  )

  const handleDateSelect = useCallback(
    async (date: Date | undefined) => {
      if (!date || !blockId) return
      const dateStr = formatDate(date)
      setPopoverOpen(false)
      if (onReschedule) {
        onReschedule(blockId, dateStr)
        return
      }
      try {
        await reschedule(blockId, dateStr)
        toast.success(t('journal.rescheduled', { date: dateStr }))
        announce(t('announce.taskRescheduled', { date: dateStr }))
      } catch (err) {
        reportIpcError('BlockListItem', 'journal.rescheduleFailed', err, t, {
          blockId,
          dateStr,
        })
        announce(t('announce.rescheduleFailed'))
      }
    },
    [blockId, onReschedule, reschedule, t],
  )

  return (
    <li
      ref={liRef}
      style={style}
      data-index={dataIndex}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 cursor-pointer transition-colors',
        // Touch: ensure 44px minimum height so embedded pills (priority, date chip)
        // with touch-device padding don't get clipped at the bottom (UX-195).
        '[@media(pointer:coarse)]:min-h-11',
        blockId && 'cursor-grab',
        isFocused && 'ring-2 ring-ring/50 bg-accent/30',
        className,
      )}
      data-testid={testId}
      data-block-list-item
      id={testId || blockId ? `block-item-${blockId}` : undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      draggable={!!blockId}
      onDragStart={(e) => {
        if (blockId) {
          e.dataTransfer.setData('application/x-block-reschedule', blockId)
          e.dataTransfer.effectAllowed = 'move'
        }
      }}
    >
      {/* Metadata row — primitive props rendered by a memoed sub-component
          so parent re-renders without prop changes don't allocate fresh
          children (perf-review Tier 1.4 metadata half). */}
      <BlockMetadataRow
        dueDateBlockId={dueDateBlockId ?? blockId}
        statusIconState={statusIconState}
        statusIconShowDone={statusIconShowDone}
        priority={priority}
        priorityVariant={priorityVariant}
        priorityBadgeClassName={priorityBadgeClassName}
        dueDate={dueDate}
        onDateChanged={onDateChanged}
        showCompletedIcon={showCompletedIcon}
        completedIconClassName={completedIconClassName}
        dependencyBlockId={dependencyBlockId}
      />

      {/* Deprecated escape-hatch metadata slot — see `metadata` prop docs. */}
      {metadata}

      {/* Block content — full content by default; callers opt into line-clamp
          via contentClassName="line-clamp-2" when a truncated preview is needed
          (e.g. SearchPanel). Agenda shows full content (UX-197). */}
      <span className={cn('text-sm min-w-0 flex-1', contentClassName)}>
        {richContent ?? emptyContentFallback ?? t('common.empty')}
      </span>

      {/* Source page breadcrumb */}
      {pageId && (
        <span
          className={cn('text-xs text-muted-foreground truncate max-w-[40%]', breadcrumbClassName)}
        >
          {breadcrumbArrow}{' '}
          {breadcrumbAsLink ? <PageLink pageId={pageId} title={pageTitle} /> : pageTitle}
        </span>
      )}

      {/* Reschedule button — visible on touch devices */}
      {blockId && (
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="reschedule-btn hidden [@media(pointer:coarse)]:inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors touch-target"
              aria-label={t('block.reschedule')}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              data-testid="reschedule-btn"
            >
              <CalendarDays className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-auto p-0"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Calendar mode="single" onSelect={handleDateSelect} data-testid="reschedule-calendar" />
          </PopoverContent>
        </Popover>
      )}
    </li>
  )
}

export const BlockListItem = memo(BlockListItemInner)
BlockListItem.displayName = 'BlockListItem'
