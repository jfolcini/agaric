import type { LucideIcon } from 'lucide-react'
import { Calendar, CalendarDays, Check, ChevronRight, Paperclip, Repeat, X } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { PropertyChip } from '@/components/properties/PropertyChip'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useIsTouch } from '@/hooks/useIsTouch'
import { type BLOCK_EVENTS, dispatchBlockEvent } from '@/lib/block-events'
import { dueDateColor, formatCompactDate, MONTH_SHORT } from '@/lib/date-utils'
import { priorityColor } from '@/lib/priority-color'
import { formatRepeatLabel } from '@/lib/repeat-utils'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'

/**
 * Display label for a priority level. priority levels are
 * user-configurable; the label is always `P{level}` so any string key
 * (numeric or alpha) renders correctly.
 */
export function priorityLabel(priority: string): string {
  return `P${priority}`
}

// Re-exported from date-utils so existing call sites + tests that import these
// Names from BlockInlineControls keep working after
// deduplication.
export { dueDateColor, formatCompactDate, MONTH_SHORT }

interface DateChipProps {
  date: string
  icon: LucideIcon
  colorClass: string
  /**
   * Typed BLOCK_EVENTS key (not a raw event-name string) so the producer here
   * stays in lockstep with the listener: a constant rename is now a compile
   * error instead of a silent desync.
   */
  eventName: keyof typeof BLOCK_EVENTS
  i18nKey: string
  chipClass: string
}

export function DateChip({
  date,
  icon: Icon,
  colorClass,
  eventName,
  i18nKey,
  chipClass,
}: DateChipProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className={cn(
        `${chipClass} flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none cursor-pointer`,
        colorClass,
      )}
      title={t(i18nKey, { date: formatCompactDate(date) })}
      aria-label={t(i18nKey, { date: formatCompactDate(date) })}
      // #1498: keep editor focus on click so the date-picker event fires (a
      // blur would flush/remount the block and swallow the click). See the
      // collapse-toggle note in BlockInlineControls for the full rationale.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        dispatchBlockEvent(eventName)
      }}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      {formatCompactDate(date)}
    </button>
  )
}

interface CheckboxStyle {
  className: string
  testId?: string
  icon?: React.ReactNode
}

const EMPTY_STYLE: CheckboxStyle = {
  className: 'task-checkbox-empty border-muted-foreground/40 transition-colors',
  testId: 'task-checkbox-empty',
}

const TASK_CHECKBOX_STYLES: Record<string, CheckboxStyle> = {
  DONE: {
    className: 'task-checkbox-done border-task-done bg-task-done flex items-center justify-center',
    testId: 'task-checkbox-done',
    icon: <Check className="h-3 w-3 text-task-done-foreground" />,
  },
  DOING: {
    className:
      'task-checkbox-doing border-task-doing bg-task-doing/20 flex items-center justify-center',
    testId: 'task-checkbox-doing',
    icon: <div className="h-1.5 w-1.5 rounded-sm bg-task-doing" />,
  },
  CANCELLED: {
    // CANCELLED is visually "closed but not completed" — muted grey with an X glyph.
    className:
      'task-checkbox-cancelled border-task-cancelled bg-task-cancelled/20 flex items-center justify-center',
    testId: 'task-checkbox-cancelled',
    icon: <X className="h-3 w-3 text-task-cancelled" />,
  },
  TODO: {
    className: 'task-checkbox-todo border-muted-foreground',
    testId: 'task-checkbox-todo',
  },
  _custom: {
    className:
      'task-checkbox-custom border-task-custom bg-task-custom/20 flex items-center justify-center',
    icon: <div className="h-1.5 w-1.5 rounded-full bg-task-custom" />,
  },
  _empty: EMPTY_STYLE,
}

export function TaskCheckbox({ state }: { state: string | null | undefined }) {
  const key = !state ? '_empty' : TASK_CHECKBOX_STYLES[state] ? state : '_custom'
  const style = TASK_CHECKBOX_STYLES[key] ?? EMPTY_STYLE
  return (
    <div
      className={cn('task-checkbox h-4 w-4 rounded border-2', style.className)}
      data-testid={style.testId}
    >
      {style.icon}
    </div>
  )
}

/**
 * #217 C2 / A3 (#1021) — the responsive cap on how many property chips render
 * inline before collapsing the rest into the `+N` overflow pill. A dense block
 * can carry priority + due + scheduled + repeat + N props + attachments; on
 * phones that wraps badly, so narrow viewports show fewer chips. Exporting the
 * limits (rather than burying `isMobile ? 2 : 3` in the component body) makes
 * the responsive display contract inspectable and testable, and keeps the
 * breakpoint values in one named place if they ever change.
 */
export const INLINE_PROPERTY_LIMITS = { mobile: 2, desktop: 3 } as const

/** Resolve the inline-property cap for the current viewport. */
export function getInlinePropertyLimit(isMobile: boolean): number {
  return isMobile ? INLINE_PROPERTY_LIMITS.mobile : INLINE_PROPERTY_LIMITS.desktop
}

export interface BlockInlineControlsProps {
  blockId: string
  hasChildren: boolean
  isCollapsed: boolean
  onToggleCollapse?: ((blockId: string) => void) | undefined
  todoState?: (string | null) | undefined
  onToggleTodo?: ((blockId: string) => void) | undefined
}

export interface BlockMetadataRowProps {
  blockId: string
  priority?: (string | null) | undefined
  onTogglePriority?: ((blockId: string) => void) | undefined
  dueDate?: (string | null) | undefined
  scheduledDate?: (string | null) | undefined
  properties?: Array<{ key: string; value: string }> | undefined
  filteredProperties: Array<{ key: string; value: string }>
  /**
   * A3 (#1021) — max number of property chips to render inline before the `+N`
   * overflow pill. When omitted, falls back to `getInlinePropertyLimit(isMobile)`
   * (the responsive default). A parent that already knows the viewport can pass
   * it explicitly so the display contract is inspectable at the call site rather
   * than hidden inside this component.
   */
  maxInlineProperties?: number | undefined
  resolveBlockTitle?: ((id: string) => string) | undefined
  attachmentCount: number
  showAttachments: boolean
  onToggleAttachments: () => void
  onEditProp: (prop: { key: string; value: string }) => void
  onEditKey: (keyInfo: { oldKey: string; value: string }) => void
}

/**
 * The row-leading collapse chevron (when the block has children) or an
 * always-reserved fixed-width placeholder slot (on leaves). Extracted to keep
 * the conditional chevron/placeholder branching out of `BlockInlineControls`'
 * complexity count.
 */
function LeadingCollapseSlot({
  blockId,
  hasChildren,
  isCollapsed,
  isTouch,
  onToggleCollapse,
}: {
  blockId: string
  hasChildren: boolean
  isCollapsed: boolean
  isTouch: boolean
  onToggleCollapse?: ((blockId: string) => void) | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  if (hasChildren) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              'collapse-toggle flex-shrink-0 w-5 p-0.5 text-muted-foreground hover:text-foreground transition-opacity focus-ring-visible active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center',
              // #1243: an EXPANDED parent hides its chevron at rest. Its
              // children are already visible below, so a persistent caret
              // just floats in the empty left gutter, detached from the
              // block text (the "caret too far left" report). It reveals on
              // the SAME per-block hover / focus-within / .block-active
              // contract as the gutter controls and the zoom bullet, so the
              // tree reads clean at rest and the toggle is right there the
              // moment you engage a block. Touch has no hover → always shown.
              !isCollapsed &&
                !isTouch &&
                'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto',
              // C4 (#216): the chevron signals collapsed/expanded by rotation
              // alone, which colour-blind users (and anyone who misses the
              // subtle 90° turn) can't reliably perceive. Add a non-rotation
              // cue — a faint filled background + ring — that only shows when
              // the block is collapsed (i.e. has hidden children). A
              // collapsed block ALSO stays visible at rest (above): it is the
              // only affordance to reveal the hidden children.
              isCollapsed && 'rounded-sm bg-muted/60 text-foreground ring-1 ring-border',
            )}
            data-testid="collapse-toggle"
            data-collapsed={isCollapsed}
            // #1498: the gutter controls live OUTSIDE the contenteditable. With
            // the block's ProseMirror editor focused, a plain click would first
            // blur the editor (flush → re-render/remount) and the pending click
            // gets swallowed — the control does nothing. preventDefault on
            // mousedown retains editor focus (no blur → no flush) so the click
            // fires and the caret stays put. Mirrors the Mermaid toggle (#1438).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onToggleCollapse?.(blockId)}
            aria-label={isCollapsed ? t('block.expandChildren') : t('block.collapseChildren')}
            aria-expanded={!isCollapsed}
            // D4 (#217): expose the Ctrl+. collapse/expand shortcut to AT.
            aria-keyshortcuts={t('block.collapseKeyshortcuts')}
          >
            <ChevronToggle isExpanded={!isCollapsed} size="lg" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {isCollapsed ? t('block.expandTip') : t('block.collapseTip')}
        </TooltipContent>
      </Tooltip>
    )
  }
  // The chevron slot is ALWAYS reserved, even on leaf-only pages: a fixed-width
  // placeholder keeps every block's text and controls aligned and prevents a
  // layout shift the moment a block loses its children (user feedback
  // 2026-06-20: "reserve the space but don't use it").
  return <span className="flex-shrink-0 w-5 h-5" aria-hidden />
}

/** The per-block task checkbox (suppressed in multi-select mode by the caller). */
function TaskMarkerButton({
  blockId,
  todoState,
  onToggleTodo,
}: {
  blockId: string
  todoState?: (string | null) | undefined
  onToggleTodo?: ((blockId: string) => void) | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'task-marker flex-shrink-0 p-0.5 transition-opacity focus-ring-visible active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center',
            // Fix 5: a block with NO todo_state renders the EMPTY checkbox,
            // which is a pure affordance ("set a task here"), not meaningful
            // state. Showing it on every row at rest clutters the whole tree,
            // so gate it behind the same per-block hover/active contract as
            // the gutter buttons — hidden at rest, revealed only when the
            // block is hovered / focus-within / `.block-active`. A block that
            // DOES carry a todo_state keeps its checkbox always visible (the
            // TODO/DOING/DONE/CANCELLED glyph IS meaningful state). On coarse
            // pointers there is no hover and the long-press menu owns setting
            // task state, so the empty checkbox stays hidden at rest there too.
            !todoState &&
              'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 [.block-active_&]:opacity-100',
          )}
          data-testid="task-marker"
          // #1498: keep editor focus on click (see collapse-toggle note).
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onToggleTodo?.(blockId)
          }}
          aria-label={todoState ? t('block.taskCycle', { state: todoState }) : t('block.setTodo')}
        >
          <TaskCheckbox state={todoState} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {todoState ? t('block.todoCycleTip', { state: todoState }) : t('block.setTodoTip')}
      </TooltipContent>
    </Tooltip>
  )
}

/** The priority badge toggle (rendered only when a priority is set). */
function PriorityBadge({
  blockId,
  priority,
  onTogglePriority,
}: {
  blockId: string
  priority: string
  onTogglePriority?: ((blockId: string) => void) | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="priority-badge flex-shrink-0 p-0.5 transition-colors focus-ring-visible active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center"
          data-testid="priority-badge"
          aria-label={t('block.priorityCycle', { level: priorityLabel(priority) })}
          // #976 (item 9) — the badge is a toggle button cycling the block's
          // priority; expose its set/unset state per WAI-ARIA toggle-button
          // semantics. The badge only renders when a priority is set, so the
          // pressed state is always `true` here.
          aria-pressed
          // #1498: keep editor focus on click (see collapse-toggle note).
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onTogglePriority?.(blockId)
          }}
        >
          <span
            className={cn(
              'inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-bold max-sm:px-2.5 max-sm:py-1',
              priorityColor(priority),
            )}
          >
            {priorityLabel(priority)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {t('block.priorityTip', { level: priorityLabel(priority) })}
      </TooltipContent>
    </Tooltip>
  )
}

/** The repeat-rule indicator chip (rendered only when a `repeat` property is set). */
function RepeatIndicator({ repeatValue }: { repeatValue: string }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- inline status chip rendered among sibling chips; native <output> carries an implicit "Output" semantic and is not a drop-in for this inline <span> badge
      role="status"
      className="repeat-indicator flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none bg-indicator-repeat text-indicator-repeat-foreground max-sm:px-2.5 max-sm:py-1"
      aria-label={t('block.repeats', { value: repeatValue })}
    >
      <Repeat className="h-3 w-3 flex-shrink-0" />
      {formatRepeatLabel(repeatValue, t)}
    </span>
  )
}

/** The inline property chips + `+N` overflow pill. */
function InlineProperties({
  filteredProperties,
  inlinePropLimit,
  resolveBlockTitle,
  onEditProp,
  onEditKey,
}: {
  filteredProperties: Array<{ key: string; value: string }>
  inlinePropLimit: number
  resolveBlockTitle?: ((id: string) => string) | undefined
  onEditProp: (prop: { key: string; value: string }) => void
  onEditKey: (keyInfo: { oldKey: string; value: string }) => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <>
      {filteredProperties.slice(0, inlinePropLimit).map((p) => {
        const displayValue = resolveBlockTitle ? resolveBlockTitle(p.value) || p.value : p.value
        return (
          <PropertyChip
            key={p.key}
            propKey={p.key}
            value={displayValue}
            onClick={() => onEditProp({ key: p.key, value: p.value })}
            onKeyClick={() => onEditKey({ oldKey: p.key, value: p.value })}
          />
        )
      })}
      {filteredProperties.length > inlinePropLimit && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="property-overflow inline-flex items-center flex-shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors select-none focus-ring-visible active:scale-95 max-sm:px-2.5 max-sm:py-1"
              data-testid="property-overflow"
              aria-label={t('block.showAllProperties', { count: filteredProperties.length })}
              // #1498: keep editor focus on click (see collapse-toggle note).
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation()
                dispatchBlockEvent('OPEN_BLOCK_PROPERTIES')
              }}
            >
              +{filteredProperties.length - inlinePropLimit}
              <ChevronRight className="h-3 w-3 ml-0.5 opacity-60" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {t('block.showAllProperties', { count: filteredProperties.length })}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  )
}

/** The collapsible-attachments badge (rendered only when the block has attachments). */
function AttachmentBadge({
  attachmentCount,
  showAttachments,
  animKey,
  onToggleAttachments,
}: {
  attachmentCount: number
  showAttachments: boolean
  animKey: number | null
  onToggleAttachments: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          key={animKey ?? 'initial'}
          type="button"
          className={cn(
            'attachment-badge flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none cursor-pointer bg-muted text-muted-foreground hover:bg-accent max-sm:px-2.5 max-sm:py-1 touch-target',
            animKey !== null && 'animate-in fade-in-0 zoom-in-95 duration-normal',
          )}
          data-testid="attachment-badge"
          aria-label={t('block.attachments', { count: attachmentCount })}
          aria-expanded={showAttachments}
          // #1498: keep editor focus on click (see collapse-toggle note).
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleAttachments}
        >
          <Paperclip className="h-3 w-3 flex-shrink-0" />
          {attachmentCount}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {t('block.attachmentsTip', { count: attachmentCount })}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Leading per-row controls rendered immediately before the block text: the
 * collapse chevron (or a reserved placeholder slot on leaves) and the task
 * checkbox. Everything else (priority, dates, repeat, property chips,
 * attachments) moved to the below-block `BlockMetadataRow` (user feedback
 * 2026-06-20).
 *
 * The chevron slot is ALWAYS reserved (a fixed-width placeholder stands in on
 * leaves) so button positions stay stable and the tree never shifts the moment
 * a block becomes a leaf — the "reserve the space but don't use it" request.
 */
export const BlockInlineControls = React.memo(
  ({
    blockId,
    hasChildren,
    isCollapsed,
    onToggleCollapse,
    todoState,
    onToggleTodo,
  }: BlockInlineControlsProps): React.ReactElement => {
    // Fix 6 / #994 — when a multi-selection is active the row enters "select"
    // mode. We suppress ONLY the task checkbox here (it doubles as an action
    // target that would be ambiguous against the selection-scoped gutter
    // checkbox); bulk task-state changes go through the batch toolbar / context
    // menu, which apply to the whole selection.
    //
    // The collapse chevron INTENTIONALLY survives selection mode (it is NOT
    // guarded by `hasSelection`). It is a per-block structural control — the
    // row-leading, slot-reserved element that also carries the
    // has-collapsed-children cue. Hiding it at selection-start would reflow every
    // row horizontally and erase the collapsed-subtree cue exactly when users are
    // picking subtrees. Best-in-class editors (Notion, Logseq) keep structural
    // toggles live during multi-select; the per-block aria-label/tooltip keeps
    // its single-block scope legible.
    const hasSelection = useBlockStore((s) => s.selectedBlockIds.length > 0)

    // #1236: the chevron's at-rest hidden state is gated on pointer-type. We use
    // a JS gate (`useIsTouch()`) rather than a `[@media(pointer:fine)]` CSS query
    // because the Linux WebKitGTK webview lies about that media query too
    // (reports coarse for a plain mouse) — `useIsTouch` additionally checks
    // `navigator.maxTouchPoints` to short-circuit the false-coarse.
    const isTouch = useIsTouch()

    return (
      <div
        className={cn(
          'inline-controls flex items-center flex-shrink-0 gap-1 max-sm:flex-shrink max-sm:w-auto max-sm:gap-x-1',
        )}
      >
        <LeadingCollapseSlot
          blockId={blockId}
          hasChildren={hasChildren}
          isCollapsed={isCollapsed}
          isTouch={isTouch}
          onToggleCollapse={onToggleCollapse}
        />

        {/* Fix 6: in multiselect mode the task checkbox is suppressed on every
          row (only the gutter select checkbox shows). */}
        {!hasSelection && (
          <TaskMarkerButton blockId={blockId} todoState={todoState} onToggleTodo={onToggleTodo} />
        )}
      </div>
    )
  },
)
BlockInlineControls.displayName = 'BlockInlineControls'

/**
 * Below-block metadata row (user feedback 2026-06-20): the interactive chips
 * that used to crowd the inline-control cluster — priority badge, due /
 * scheduled date chips, repeat indicator, property chips (+ overflow) and the
 * attachment badge — now render on their own row under the block text,
 * left-aligned with it. They stay fully interactive (priority cycles, dates open
 * pickers, chips edit, attachments toggle) and ALWAYS visible at rest, since
 * each carries meaningful state worth seeing at a glance.
 *
 * Renders nothing when the block carries no metadata, so leaves add no row.
 */
export const BlockMetadataRow = React.memo(
  ({
    blockId,
    priority,
    onTogglePriority,
    dueDate,
    scheduledDate,
    properties,
    filteredProperties,
    maxInlineProperties,
    resolveBlockTitle,
    attachmentCount,
    showAttachments,
    onToggleAttachments,
    onEditProp,
    onEditKey,
  }: BlockMetadataRowProps): React.ReactElement | null => {
    // #217 C2 / A3 (#1021): cap how many property chips render inline before the
    // `+N` overflow pill, relieving chip density on narrow viewports. The parent
    // may pass `maxInlineProperties` explicitly (inspectable contract); otherwise
    // we derive it from the viewport via the named limits.
    const isMobile = useIsMobile()
    const inlinePropLimit = maxInlineProperties ?? getInlinePropertyLimit(isMobile)

    // Play a one-shot bump animation when the attachment count changes
    // (file dropped/pasted). `animKey` starts as null so the very first render
    // has no animation classes; subsequent count changes set it to the new
    // count, which (a) re-keys the badge to force a remount and replay the
    // CSS animation, and (b) flips the className to include `animate-in
    // fade-in-0 zoom-in-95 duration-normal`. `prefers-reduced-motion` collapses
    // the duration tokens to 0ms in `index.css`.
    const prevAttachmentCountRef = React.useRef(attachmentCount)
    const [animKey, setAnimKey] = React.useState<number | null>(null)
    React.useEffect(() => {
      if (prevAttachmentCountRef.current !== attachmentCount) {
        prevAttachmentCountRef.current = attachmentCount
        setAnimKey(attachmentCount)
      }
    }, [attachmentCount])

    // The `repeat` property (if any) drives the repeat indicator chip.
    const repeatValue = properties?.find((p) => p.key === 'repeat')?.value

    const hasContent =
      Boolean(priority) ||
      Boolean(dueDate) ||
      Boolean(scheduledDate) ||
      repeatValue !== undefined ||
      filteredProperties.length > 0 ||
      attachmentCount > 0

    // No metadata → no row (leaves don't add an empty gap below the text).
    if (!hasContent) return null

    return (
      <div className="block-metadata-row flex items-center flex-wrap gap-1 mt-0.5">
        {priority && (
          <PriorityBadge
            blockId={blockId}
            priority={priority}
            onTogglePriority={onTogglePriority}
          />
        )}

        {dueDate && (
          <DateChip
            date={dueDate}
            icon={CalendarDays}
            colorClass={dueDateColor(dueDate)}
            eventName="OPEN_DUE_DATE_PICKER"
            i18nKey="block.dueDate"
            chipClass="due-date-chip"
          />
        )}

        {scheduledDate && (
          // The due-date chip uses `dueDateColor(dueDate)` to colour-code
          // overdue / today / future tasks because a due date is meaningful
          // in all three temporal states. The scheduled date is intentionally
          // static (`bg-date-scheduled`) — Org-mode's SCHEDULED semantics are
          // future-only ("don't start before this date"), so there is no
          // past/today/future distinction to surface visually.
          <DateChip
            date={scheduledDate}
            icon={Calendar}
            colorClass="bg-date-scheduled text-date-scheduled-foreground"
            eventName="OPEN_SCHEDULED_DATE_PICKER"
            i18nKey="block.scheduledDate"
            chipClass="scheduled-chip"
          />
        )}

        {repeatValue !== undefined && <RepeatIndicator repeatValue={repeatValue} />}

        {filteredProperties.length > 0 && (
          <InlineProperties
            filteredProperties={filteredProperties}
            inlinePropLimit={inlinePropLimit}
            resolveBlockTitle={resolveBlockTitle}
            onEditProp={onEditProp}
            onEditKey={onEditKey}
          />
        )}

        {attachmentCount > 0 && (
          <AttachmentBadge
            attachmentCount={attachmentCount}
            showAttachments={showAttachments}
            animKey={animKey}
            onToggleAttachments={onToggleAttachments}
          />
        )}
      </div>
    )
  },
)
BlockMetadataRow.displayName = 'BlockMetadataRow'
