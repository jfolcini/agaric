import type { LucideIcon } from 'lucide-react'
import { Calendar, CalendarDays, Check, ChevronRight, Paperclip, Repeat, X } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { PropertyChip } from '@/components/properties/PropertyChip'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBlockActions } from '@/hooks/useBlockActions'
import { useIsMobile } from '@/hooks/useIsMobile'
import { dispatchBlockEvent } from '@/lib/block-events'
import { dueDateColor, formatCompactDate, MONTH_SHORT } from '@/lib/date-utils'
import { priorityColor } from '@/lib/priority-color'
import { formatRepeatLabel } from '@/lib/repeat-utils'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'

/**
 * Display label for a priority level. UX-201b: priority levels are
 * user-configurable; the label is always `P{level}` so any string key
 * (numeric or alpha) renders correctly.
 */
export function priorityLabel(priority: string): string {
  return `P${priority}`
}

// Re-exported from date-utils so existing call sites + tests that import these
// names from BlockInlineControls keep working after MAINT-94 / MAINT-129
// deduplication.
export { dueDateColor, formatCompactDate, MONTH_SHORT }

interface DateChipProps {
  date: string
  icon: LucideIcon
  colorClass: string
  eventName: string
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
      onClick={() => {
        document.dispatchEvent(new CustomEvent(eventName))
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

export interface BlockInlineControlsProps {
  blockId: string
  hasChildren: boolean
  isCollapsed: boolean
  onToggleCollapse?: ((blockId: string) => void) | undefined
  todoState?: (string | null) | undefined
  onToggleTodo?: ((blockId: string) => void) | undefined
  priority?: (string | null) | undefined
  onTogglePriority?: ((blockId: string) => void) | undefined
  dueDate?: (string | null) | undefined
  scheduledDate?: (string | null) | undefined
  properties?: Array<{ key: string; value: string }> | undefined
  filteredProperties: Array<{ key: string; value: string }>
  resolveBlockTitle?: ((id: string) => string) | undefined
  /** Whether any sibling block in the tree has children. When false, skip the caret placeholder. */
  anyBlockHasChildren: boolean
  /**
   * #927 f3: tap-the-bullet zoom-in handler. When omitted, falls back to the
   * `onZoomIn` published on the `BlockActions` context (production wires it
   * there via `BlockActionsProvider`); the explicit prop lets isolated tests
   * drive the bullet without standing up a provider.
   */
  onZoomIn?: ((blockId: string) => void) | undefined
  attachmentCount: number
  showAttachments: boolean
  onToggleAttachments: () => void
  onEditProp: (prop: { key: string; value: string }) => void
  onEditKey: (keyInfo: { oldKey: string; value: string }) => void
}

export const BlockInlineControls = React.memo(function BlockInlineControls({
  blockId,
  hasChildren,
  isCollapsed,
  onToggleCollapse,
  todoState,
  onToggleTodo,
  priority,
  onTogglePriority,
  dueDate,
  scheduledDate,
  properties,
  filteredProperties,
  resolveBlockTitle,
  anyBlockHasChildren,
  onZoomIn,
  attachmentCount,
  showAttachments,
  onToggleAttachments,
  onEditProp,
  onEditKey,
}: BlockInlineControlsProps): React.ReactElement {
  const { t } = useTranslation()

  // #927 f3: prefer the explicit prop (test fixtures), else read the zoom-in
  // handler off the action bag the BlockTree publishes in production.
  const actionsZoomIn = useBlockActions().onZoomIn
  const zoomIn = onZoomIn ?? actionsZoomIn

  // Fix 6 / #994 — when a multi-selection is active the row enters "select"
  // mode. We suppress ONLY the task checkbox here (it doubles as an action
  // target that would be ambiguous against the selection-scoped gutter
  // checkbox); bulk task-state changes go through the batch toolbar / context
  // menu, which apply to the whole selection.
  //
  // The collapse chevron and the zoom bullet INTENTIONALLY survive selection
  // mode (they are NOT guarded by `hasSelection`). They are per-block
  // structural / navigation controls — the chevron is the row-leading,
  // slot-reserved element that also carries the has-collapsed-children cue, and
  // the bullet zooms into a single block. Hiding the chevron at selection-start
  // would reflow every row horizontally and erase the collapsed-subtree cue
  // exactly when users are picking subtrees. Best-in-class editors (Notion,
  // Logseq) keep structural toggles live during multi-select; their per-block
  // aria-label/tooltip keeps their single-block scope legible. Any
  // selection-wide collapse belongs on the batch toolbar / context menu, never
  // overloaded onto the row chevron.
  const hasSelection = useBlockStore((s) => s.selectedBlockIds.length > 0)

  // #217 C2 (remainder): relieve inline-control density on narrow viewports.
  // A dense block can carry priority + due + scheduled + repeat + N props +
  // attachments; on phones that wraps badly. Show only 2 inline property chips
  // before the `+N` overflow pill on narrow viewports (≥768px keeps 3).
  const isMobile = useIsMobile()
  const inlinePropLimit = isMobile ? 2 : 3

  // UX-308: Play a one-shot bump animation when the attachment count changes
  // (file dropped/pasted). `animKey` starts as null so the very first render
  // has no animation classes; subsequent count changes set it to the new
  // count, which (a) re-keys the badge to force a remount and replay the
  // CSS animation, and (b) flips the className to include `animate-in
  // fade-in-0 zoom-in-95 duration-150`. `prefers-reduced-motion` collapses
  // the duration tokens to 0ms in `index.css`.
  const prevAttachmentCountRef = React.useRef(attachmentCount)
  const [animKey, setAnimKey] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (prevAttachmentCountRef.current !== attachmentCount) {
      prevAttachmentCountRef.current = attachmentCount
      setAnimKey(attachmentCount)
    }
  }, [attachmentCount])

  return (
    <div
      className={cn(
        'inline-controls flex items-center flex-shrink-0 gap-1 max-sm:flex-shrink max-sm:flex-wrap max-sm:w-auto max-sm:gap-x-1 max-sm:gap-y-1.5',
      )}
    >
      {hasChildren ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'collapse-toggle flex-shrink-0 w-5 p-0.5 text-muted-foreground hover:text-foreground transition-opacity focus-ring-visible active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center',
                // C4 (#216): the chevron signals collapsed/expanded by rotation
                // alone, which colour-blind users (and anyone who misses the
                // subtle 90° turn) can't reliably perceive. Add a non-rotation
                // cue — a faint filled background + ring — that only shows when
                // the block is collapsed (i.e. has hidden children).
                isCollapsed && 'rounded-sm bg-muted/60 text-foreground ring-1 ring-border',
              )}
              data-testid="collapse-toggle"
              data-collapsed={isCollapsed}
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
      ) : // Only reserve space for the caret if at least one block in the tree has children.
      // This avoids an unsightly gap on leaf-only pages.
      anyBlockHasChildren ? (
        <span className="flex-shrink-0 w-5 h-5" aria-hidden />
      ) : null}

      {/* #927 f3: tap-the-bullet zoom (Logseq's signature gesture). Rendered on
          every row (leaves too) for a consistent affordance, but HIDDEN AT REST —
          it follows the same per-block hover/focus/active contract as the gutter
          controls (opacity-0 → revealed on group-hover / group-focus-within /
          .block-active), so it only shows for the hovered or selected block and
          doesn't clutter the tree. Tap/click zooms into the block; the collapse
          chevron carries the has-children/collapsed cue. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              'block-bullet group/bullet flex-shrink-0 flex items-center justify-center w-5 h-5 p-0 text-muted-foreground transition-colors focus-ring-visible active:scale-95 touch-target',
              'hover:text-foreground',
              // FINE pointers (desktop): hidden at rest, revealed only on this
              // block's hover / focus-within / active (selection), matching
              // GUTTER_BUTTON_BASE. COARSE pointers (touch): NOT hidden — there is
              // no hover, and the bullet is the tap-to-zoom target (#927 f3), so it
              // must stay visible/tappable at rest (like the touch drag handle).
              '[@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [.block-active_&]:opacity-100 [.block-active_&]:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto',
            )}
            data-testid="block-bullet"
            data-has-children={hasChildren}
            data-collapsed={isCollapsed}
            aria-label={isCollapsed ? t('block.zoomBulletCollapsed') : t('block.zoomBullet')}
            onClick={(e) => {
              e.stopPropagation()
              zoomIn?.(blockId)
            }}
          >
            {/* The ring halo (visible only when the block has hidden children)
                is the non-zoom collapsed cue; the inner dot is the bullet. */}
            <span
              className={cn(
                'flex items-center justify-center rounded-full transition-colors',
                isCollapsed ? 'h-4 w-4 bg-muted/60 ring-1 ring-border' : 'h-4 w-4',
              )}
              aria-hidden
            >
              <span className="block h-1.5 w-1.5 rounded-full bg-current group-hover/bullet:bg-current" />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t('block.zoomBulletTip')}
        </TooltipContent>
      </Tooltip>

      {/* Fix 6: in multiselect mode the task checkbox is suppressed on every
          row (only the gutter select checkbox shows). */}
      {!hasSelection && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'task-marker flex-shrink-0 p-0.5 transition-colors focus-ring-visible active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center',
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
              onClick={(e) => {
                e.stopPropagation()
                onToggleTodo?.(blockId)
              }}
              aria-label={
                todoState ? t('block.taskCycle', { state: todoState }) : t('block.setTodo')
              }
            >
              <TaskCheckbox state={todoState} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {todoState ? t('block.todoCycleTip', { state: todoState }) : t('block.setTodoTip')}
          </TooltipContent>
        </Tooltip>
      )}

      {priority && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="priority-badge flex-shrink-0 p-0.5 transition-colors focus-ring-visible active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center"
              data-testid="priority-badge"
              aria-label={t('block.priorityCycle', { level: priorityLabel(priority) })}
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
      )}

      {dueDate && (
        <DateChip
          date={dueDate}
          icon={CalendarDays}
          colorClass={dueDateColor(dueDate)}
          eventName="open-due-date-picker"
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
          eventName="open-scheduled-date-picker"
          i18nKey="block.scheduledDate"
          chipClass="scheduled-chip"
        />
      )}

      {properties?.some((p) => p.key === 'repeat') && (
        <span
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- inline status chip rendered among sibling chips; native <output> carries an implicit "Output" semantic and is not a drop-in for this inline <span> badge
          role="status"
          className="repeat-indicator flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none bg-indicator-repeat text-indicator-repeat-foreground max-sm:px-2.5 max-sm:py-1"
          aria-label={t('block.repeats', {
            value: properties.find((p) => p.key === 'repeat')?.value ?? '',
          })}
        >
          <Repeat className="h-3 w-3 flex-shrink-0" />
          {formatRepeatLabel(properties.find((p) => p.key === 'repeat')?.value ?? '', t)}
        </span>
      )}

      {filteredProperties.length > 0 && (
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
                  aria-label={t('block.showAllProperties', {
                    count: filteredProperties.length,
                  })}
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
      )}

      {attachmentCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              key={animKey ?? 'initial'}
              type="button"
              className={cn(
                'attachment-badge flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none cursor-pointer bg-muted text-muted-foreground hover:bg-accent max-sm:px-2.5 max-sm:py-1 touch-target',
                animKey !== null && 'animate-in fade-in-0 zoom-in-95 duration-150',
              )}
              data-testid="attachment-badge"
              aria-label={t('block.attachments', { count: attachmentCount })}
              aria-expanded={showAttachments}
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
      )}
    </div>
  )
})
