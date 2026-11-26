/**
 * BlockListItem — the one task row (#7040): a block as a row of a list
 * (DuePanel and its Overdue / Scheduled earlier / Upcoming sections,
 * DonePanel, AgendaResults).
 *
 * A clickable `<li>`, read in one order everywhere:
 *   [checkbox or state icon] → [title] → [metadata chips] → [source page]
 * On one line from `sm` up; below it the title keeps the checkbox's line and
 * the chips and source wrap under it.
 *
 * The leading control and the chips are rendered from typed primitive props
 * (`taskState`, `priority`, `dueDate`, `scheduledDate`, `dependencyBlockId`,
 * `showCompletedIcon`) so that `React.memo` shallow-compare can hit across
 * parent re-renders.
 */

import { CalendarDays, CheckCircle2 } from 'lucide-react'
import type React from 'react'
import { lazy, memo, Suspense, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DateChip, type DateKind } from '@/components/common/DateChip'
import { DependencyIndicator } from '@/components/common/DependencyIndicator'
import { NewTabTarget } from '@/components/common/NewTabTarget'
import { TaskMarkerButton } from '@/components/editor/TaskMarkerButton'
import { PageLink } from '@/components/pages/PageLink'
import { DateChipEditor } from '@/components/properties/DateChipEditor'
import { renderRichContent } from '@/components/RichContentRenderer'
import { Badge } from '@/components/ui/badge'
import { listRowVariants } from '@/components/ui/list-item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { StatusIcon } from '@/components/ui/status-icon'
import { useBlockReschedule } from '@/hooks/useBlockReschedule'
import { useRovingRowFocus } from '@/hooks/useListKeyboardNavigation'
import { useRichContentCallbacks, useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { useTaskStateCycle } from '@/hooks/useTaskStateCycle'
import { displayPageTitle, formatDate } from '@/lib/date-utils'
import { notify } from '@/lib/notify'
import { reportIpcError } from '@/lib/report-ipc-error'
import { cn } from '@/lib/utils'
import { useResolveStore } from '@/stores/resolve'

// #5441 — lazy: react-day-picker loads when a reschedule popover first opens,
// not with every agenda/due-panel row.
const Calendar = lazy(() =>
  import('@/components/ui/calendar').then((m) => ({ default: m.Calendar })),
)

// ── Inline editable date chip ─────────────────────────────────────────
// A row's `DateChip` as the trigger of a Popover + DateChipEditor, so a due
// or scheduled date is changed inline without leaving the list view.

interface RowDateChipProps {
  kind: DateKind
  blockId: string | null | undefined
  date: string
  onDateChanged: (() => void) | undefined
}

function RowDateChipInner({
  kind,
  blockId,
  date,
  onDateChanged,
}: RowDateChipProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const chipButton = (
    <DateChip
      kind={kind}
      date={date}
      className={kind === 'due' ? 'agenda-results-due' : undefined}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    />
  )

  return (
    <Popover open={open} onOpenChange={setOpen} sheetTitle={t('dateChip.editDate')}>
      <PopoverTrigger asChild>{chipButton}</PopoverTrigger>
      {blockId && (
        <PopoverContent
          align="start"
          className="w-64 max-w-[calc(100vw-2rem)]"
          data-testid={`${kind}-date-popover`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {/* Closes the surface and refreshes; DateChipEditor fires its own
              notify.success + announce on save, so no toast here. */}
          <DateChipEditor
            blockId={blockId}
            dateType={kind}
            currentDate={date}
            onSuccess={() => {
              setOpen(false)
              onDateChanged?.()
            }}
          />
        </PopoverContent>
      )}
    </Popover>
  )
}

const RowDateChip = memo(RowDateChipInner)
RowDateChip.displayName = 'RowDateChip'

// ── Leading control and metadata chips ────────────────────────────────
// Rendered from typed primitive props so `React.memo` on `BlockListItem`
// can shallow-compare them instead of always-fresh ReactNode references.

interface RowLeadProps {
  blockId: string | null | undefined
  taskState: string | null | undefined
  statusIconState: string | null | undefined
  statusIconShowDone: boolean | undefined
  showCompletedIcon: boolean | undefined
  completedIconClassName: string | undefined
}

/** What leads the row, before its title: the task checkbox, or a state icon. */
function RowLead({
  blockId,
  taskState,
  statusIconState,
  statusIconShowDone,
  showCompletedIcon,
  completedIconClassName,
}: RowLeadProps): React.ReactElement {
  const cycleTaskState = useTaskStateCycle()
  return (
    <>
      {taskState && blockId && (
        <TaskMarkerButton
          blockId={blockId}
          todoState={taskState}
          onToggleTodo={(id) => void cycleTaskState(id, taskState)}
        />
      )}

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
    </>
  )
}

interface RowMetadataProps {
  blockId: string | null | undefined
  priority: string | null | undefined
  priorityBadgeClassName: string | undefined
  dueDate: string | null | undefined
  scheduledDate: string | null | undefined
  onDateChanged: (() => void) | undefined
  dependencyBlockId: string | undefined
  note: string | undefined
}

/** The chips after the title, in a block's own order: priority, due, scheduled. */
function RowMetadataInner({
  blockId,
  priority,
  priorityBadgeClassName,
  dueDate,
  scheduledDate,
  onDateChanged,
  dependencyBlockId,
  note,
}: RowMetadataProps): React.ReactElement {
  return (
    <>
      {priority != null && priority !== '' && (
        <Badge
          tone="priority"
          size="sm"
          priorityLevel={priority}
          {...(priorityBadgeClassName !== undefined && { className: priorityBadgeClassName })}
        >
          P{priority}
        </Badge>
      )}

      {dueDate && (
        <RowDateChip kind="due" blockId={blockId} date={dueDate} onDateChanged={onDateChanged} />
      )}

      {scheduledDate && (
        <RowDateChip
          kind="scheduled"
          blockId={blockId}
          date={scheduledDate}
          onDateChanged={onDateChanged}
        />
      )}

      {note !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{note}</span>}

      {dependencyBlockId && <DependencyIndicator blockId={dependencyBlockId} />}
    </>
  )
}

const RowMetadata = memo(RowMetadataInner)
RowMetadata.displayName = 'RowMetadata'

/**
 * Below `sm` the title keeps the first line, after the leading status icon
 * (the row's only `svg` child) or task checkbox, and the chips and source wrap
 * under it: on one line a 360 px phone squeezed the title to a few characters
 * a line. The leading control hangs in the row's padding (a negative margin as
 * wide as the control and its gap), so the title and the chips under it share
 * one left edge beside it.
 */
function leadHangClass({
  taskState,
  statusIconState,
  statusIconShowDone,
  showCompletedIcon,
}: Omit<RowLeadProps, 'blockId' | 'completedIconClassName'>): string | undefined {
  if (taskState) {
    // The checkbox's 1.125em box and its p-0.5, then the row's gap-2.
    return 'max-sm:pl-[calc(0.75rem+1.875rem)] max-sm:[&>.task-marker]:-ml-[1.875rem] max-sm:[&>.task-marker]:self-start'
  }
  const hasIcon =
    showCompletedIcon === true ||
    (statusIconState !== undefined && !(statusIconState === 'DONE' && statusIconShowDone === false))
  return hasIcon
    ? 'max-sm:pl-[calc(0.75rem+1.5rem)] max-sm:[&>svg]:-ml-[1.5rem] max-sm:[&>svg]:self-start max-sm:[&>svg]:mt-0.5'
    : undefined
}

// ── BlockListItem ──────────────────────────────────────────────────────

export interface BlockListItemProps {
  /** Block content text — truncated via CSS line-clamp. */
  content: string | null
  /** Max characters before truncation. Default 120. */
  contentMaxLength?: number
  /** Fallback text when content is null/empty. Defaults to the localized "(empty)" string. */
  emptyContentFallback?: string
  // ── Typed metadata primitives (perf-review Tier 1.4 metadata half) ──

  /**
   * The block's task state, drawn as the block's own checkbox, which cycles it
   * (#6544). Toggles the block `dueDateBlockId ?? blockId` names; omit, or pass
   * `null` for a block that is not a task, to draw none.
   */
  taskState?: string | null
  /**
   * Status icon state (e.g. `'TODO'`, `'DOING'`, `'DONE'`, `'CANCELLED'`).
   * Pass `null` to render the default TODO circle; omit to skip entirely.
   */
  statusIconState?: string | null
  /** Whether the DONE state status icon is shown. Default `true`. */
  statusIconShowDone?: boolean
  /** Priority string ('1' / '2' / '3' / custom). Omit / null / empty to skip. */
  priority?: string | null
  /** Extra classes for the priority badge. */
  priorityBadgeClassName?: string
  /** Due date chip — ISO YYYY-MM-DD. Omit / null / empty to skip. */
  dueDate?: string | null
  /** Scheduled date chip — ISO YYYY-MM-DD. Omit / null / empty to skip. */
  scheduledDate?: string | null
  /**
   * Block ID for the checkbox and the inline date editors. Separate from
   * the outer `blockId` prop so callers can render them without opting
   * into HTML5 drag + the touch-only reschedule button (e.g. `AgendaResults`).
   */
  dueDateBlockId?: string | null
  /** Callback fired after an inline date editor saves. */
  onDateChanged?: () => void
  /** Plain text after the chips, e.g. how long a task has been overdue. */
  note?: string
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
  taskState,
  statusIconState,
  statusIconShowDone,
  priority,
  priorityBadgeClassName,
  dueDate,
  scheduledDate,
  dueDateBlockId,
  onDateChanged,
  note,
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
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName, resolveTagStatus } =
    useRichContentCallbacks()
  const onTagClick = useTagClickHandler()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const { reschedule } = useBlockReschedule()

  // The resolve callbacks are stable identities (`useCallback` with empty
  // deps inside `useRichContentCallbacks`) backed by a mutable cache ref,
  // so the memo would never recompute on cache repopulation by itself.
  // Subscribe to `version` (bumped by preload / set / clearAllForSpace)
  // and include it in the deps so links re-resolve once the space-switch
  // preload lands — otherwise we render the `[[ULID]]` fallback
  // indefinitely after a switch. The callbacks themselves are listed
  // explicitly (rather than oxlint-disabled) so a future regression that
  // makes them non-stable surfaces as a memo recompute instead of stale
  // rendered output.
  const resolveVersion = useResolveStore((s) => s.version)
  const richContent = useMemo(
    () =>
      content
        ? renderRichContent(content, {
            interactive: true,
            onTagClick,
            resolveBlockTitle,
            resolveBlockStatus,
            resolveTagName,
            resolveTagStatus,
          })
        : null,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolveVersion is intentionally load-bearing — the callbacks read a mutable cache via refs that oxlint cannot see through, so the version is the only trigger for re-resolution when the resolve store updates.
    [
      content,
      onTagClick,
      resolveBlockTitle,
      resolveBlockStatus,
      resolveTagName,
      resolveTagStatus,
      resolveVersion,
    ],
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
        notify.success(t('journal.rescheduled', { date: dateStr }))
      } catch (err) {
        reportIpcError('BlockListItem', 'journal.rescheduleFailed', err, t, {
          blockId,
          dateStr,
        })
      }
    },
    [blockId, onReschedule, reschedule, t],
  )

  // #1520 — roving tabindex. When a consumer drives keyboard navigation it
  // passes `isFocused`: the focused row is the single tab stop (`0`) and the
  // rest rove out of the Tab order (`-1`), so the list has exactly one tab
  // stop instead of one per row. Consumers WITHOUT a roving model omit
  // `isFocused` entirely — for those, absent
  // `isFocused` keeps every row tab-reachable (`0`) so keyboard users aren't
  // stranded. Only an explicit `isFocused === false` removes a row from the
  // Tab order.
  const rovingTabIndex = isFocused === false ? -1 : 0
  const rowRef = useRovingRowFocus<HTMLLIElement>(isFocused)
  const setRowRef = useCallback(
    (node: HTMLLIElement | null) => {
      rowRef.current = node
      liRef?.(node)
    },
    [rowRef, liRef],
  )

  const leadHang = leadHangClass({
    taskState,
    statusIconState,
    statusIconShowDone,
    showCompletedIcon,
  })

  const row = (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- this li is the focusable, keyboard-navigable list row itself (roving tabindex + Enter/Space activation via onKeyDown); the activation handlers belong on the row, and it can't become a <button> because it is a list item that contains nested interactive controls (date chip, reschedule button)
    <li
      ref={setRowRef}
      style={style}
      data-index={dataIndex}
      className={cn(
        listRowVariants({
          // Two lines below `sm`, so less padding around them: the row stays
          // near one touch target tall.
          className: 'gap-2 cursor-pointer max-sm:flex-wrap max-sm:gap-y-1 max-sm:py-1.5',
        }),
        leadHang,
        blockId && 'cursor-grab',
        isFocused && 'list-cursor',
        className,
      )}
      data-testid={testId}
      data-block-list-item
      id={testId || blockId ? `block-item-${blockId}` : undefined}
      tabIndex={rovingTabIndex}
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
      <RowLead
        blockId={dueDateBlockId ?? blockId}
        taskState={taskState}
        statusIconState={statusIconState}
        statusIconShowDone={statusIconShowDone}
        showCompletedIcon={showCompletedIcon}
        completedIconClassName={completedIconClassName}
      />

      {/* Block content — full content by default; callers opt into line-clamp
          via contentClassName="line-clamp-2" when a truncated preview is needed
          (e.g. SearchPanel). Agenda shows full content. */}
      <span
        className={cn(
          'tag-chip-row text-sm min-w-0 max-sm:basis-full bidi-plaintext',
          contentClassName,
        )}
      >
        {richContent ?? emptyContentFallback ?? t('common.empty')}
      </span>

      <RowMetadata
        blockId={dueDateBlockId ?? blockId}
        priority={priority}
        priorityBadgeClassName={priorityBadgeClassName}
        dueDate={dueDate}
        scheduledDate={scheduledDate}
        onDateChanged={onDateChanged}
        dependencyBlockId={dependencyBlockId}
        note={note}
      />

      {/* Source page breadcrumb */}
      {pageId && (
        <span
          className={cn(
            // Below `sm` it takes what the chips leave of their line, and
            // shortens before it wraps onto a line of its own. The padding,
            // taken back by the margin, holds the link's 3 px focus ring,
            // which `truncate` would clip.
            'text-xs text-muted-foreground truncate max-w-[40%] -m-[3px] p-[3px] sm:ml-auto max-sm:max-w-none max-sm:min-w-16 max-sm:flex-1 max-sm:basis-0',
            breadcrumbClassName,
          )}
        >
          {breadcrumbArrow}{' '}
          {breadcrumbAsLink ? (
            <PageLink pageId={pageId} title={pageTitle} />
          ) : (
            displayPageTitle(pageTitle)
          )}
        </span>
      )}

      {/* Reschedule button — visible on touch devices */}
      {blockId && (
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              // Its 44 px target is the invisible hit area: as a 44 px box it
              // made every row two targets tall.
              className="reschedule-btn hidden [@media(pointer:coarse)]:inline-flex shrink-0 items-center justify-center rounded-md p-0.5 max-sm:ml-auto text-muted-foreground hover:text-foreground hover:bg-accent transition-colors touch-hit-area focus-ring-visible"
              aria-label={t('block.reschedule')}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              data-testid="reschedule-btn"
            >
              <CalendarDays className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          {/* Outside the content so the popover shell and calendar appear together. */}
          <Suspense fallback={null}>
            <PopoverContent
              align="end"
              className="w-auto p-0"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Calendar
                mode="single"
                onSelect={(date) => void handleDateSelect(date)}
                data-testid="reschedule-calendar"
              />
            </PopoverContent>
          </Suspense>
        </Popover>
      )}
    </li>
  )
  return pageId && onClick ? (
    <NewTabTarget pageId={pageId} title={pageTitle ?? ''}>
      {row}
    </NewTabTarget>
  ) : (
    row
  )
}

export const BlockListItem = memo(BlockListItemInner)
BlockListItem.displayName = 'BlockListItem'
