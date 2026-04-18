import type { LucideIcon } from 'lucide-react'
import { Calendar, CalendarDays, Check, Paperclip, Repeat } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { priorityColor } from '../lib/priority-color'
import { formatRepeatLabel } from '../lib/repeat-utils'
import { cn } from '../lib/utils'
import { PropertyChip } from './PropertyChip'
import { ChevronToggle } from './ui/chevron-toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export const PRIORITY_DISPLAY: Record<string, string> = { '1': 'P1', '2': 'P2', '3': 'P3' }

export const MONTH_SHORT = [
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

export function formatCompactDate(dateStr: string): string {
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

export function dueDateColor(dateStr: string): string {
  const now = new Date()
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (dateStr < todayStr) return 'bg-destructive/10 text-destructive'
  if (dateStr === todayStr) return 'bg-status-pending text-status-pending-foreground'
  return 'bg-muted text-muted-foreground'
}

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
    icon: <Check className="h-3 w-3 text-white" />,
  },
  DOING: {
    className:
      'task-checkbox-doing border-task-doing bg-task-doing/20 flex items-center justify-center',
    testId: 'task-checkbox-doing',
    icon: <div className="h-1.5 w-1.5 rounded-sm bg-task-doing" />,
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
  attachmentCount,
  showAttachments,
  onToggleAttachments,
  onEditProp,
  onEditKey,
}: BlockInlineControlsProps): React.ReactElement {
  const { t } = useTranslation()

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
              className="collapse-toggle flex-shrink-0 w-5 p-0.5 text-muted-foreground hover:text-foreground transition-opacity focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center"
              data-testid="collapse-toggle"
              onClick={() => onToggleCollapse?.(blockId)}
              aria-label={isCollapsed ? t('block.expandChildren') : t('block.collapseChildren')}
              aria-expanded={!isCollapsed}
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

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="task-marker flex-shrink-0 p-0.5 transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center"
            data-testid="task-marker"
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

      {priority && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="priority-badge flex-shrink-0 p-0.5 transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center"
              data-testid="priority-badge"
              aria-label={t('block.priorityCycle', { level: PRIORITY_DISPLAY[priority] })}
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
                {PRIORITY_DISPLAY[priority]}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {t('block.priorityTip', { level: PRIORITY_DISPLAY[priority] })}
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
        <button
          type="button"
          className="repeat-indicator flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none bg-indicator-repeat text-indicator-repeat-foreground max-sm:px-2.5 max-sm:py-1"
          aria-label={t('block.repeats', {
            value: properties.find((p) => p.key === 'repeat')?.value ?? '',
          })}
        >
          <Repeat className="h-3 w-3 flex-shrink-0" />
          {formatRepeatLabel(properties.find((p) => p.key === 'repeat')?.value ?? '')}
        </button>
      )}

      {filteredProperties.length > 0 && (
        <>
          {filteredProperties.slice(0, 3).map((p) => {
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
          {filteredProperties.length > 3 && (
            <span className="text-xs text-muted-foreground select-none">
              +{filteredProperties.length - 3}
            </span>
          )}
        </>
      )}

      {attachmentCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="attachment-badge flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium leading-none select-none cursor-pointer bg-muted text-muted-foreground hover:bg-accent max-sm:px-2.5 max-sm:py-1 touch-target"
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
