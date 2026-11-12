/**
 * The task checkbox — the one drawing of a task's state, in a block and in the
 * Due panel, Agenda and query rows (#6544) — and the button that cycles it.
 */

import { Check, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface CheckboxStyle {
  className: string
  testId?: string
  /** Drawn at render, so a module that only imports this one draws no icon it does not show. */
  icon?: () => React.ReactNode
}

/**
 * A state's dot: a circle at the centre of the box's inner square, drawn as an
 * SVG that fills it, so it stays round and centred at any font size and pixel
 * ratio, where a box sized in `em` is snapped to whole pixels off centre.
 */
function TaskDot({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 12 12" className={cn('size-full', className)} aria-hidden="true">
      <circle cx="6" cy="6" r="3" fill="currentColor" />
    </svg>
  )
}

const EMPTY_STYLE: CheckboxStyle = {
  className: 'task-checkbox-empty border-muted-foreground/40 transition-colors',
  testId: 'task-checkbox-empty',
}

const TASK_CHECKBOX_STYLES: Record<string, CheckboxStyle> = {
  DONE: {
    className: 'task-checkbox-done border-task-done bg-task-done flex items-center justify-center',
    testId: 'task-checkbox-done',
    icon: () => <Check className="size-[0.75em] text-task-done-foreground" />,
  },
  DOING: {
    className:
      'task-checkbox-doing border-task-doing bg-task-doing/20 flex items-center justify-center',
    testId: 'task-checkbox-doing',
    icon: () => <TaskDot className="text-task-doing" />,
  },
  CANCELLED: {
    // CANCELLED is visually "closed but not completed" — muted grey with an X glyph.
    className:
      'task-checkbox-cancelled border-task-cancelled bg-task-cancelled/20 flex items-center justify-center',
    testId: 'task-checkbox-cancelled',
    icon: () => <X className="size-[0.75em] text-task-cancelled" />,
  },
  TODO: {
    className: 'task-checkbox-todo border-muted-foreground',
    testId: 'task-checkbox-todo',
  },
  _custom: {
    className:
      'task-checkbox-custom border-task-custom bg-task-custom/20 flex items-center justify-center',
    icon: () => <TaskDot className="text-task-custom" />,
  },
  _empty: EMPTY_STYLE,
}

export function TaskCheckbox({ state }: { state: string | null | undefined }) {
  const key = !state ? '_empty' : TASK_CHECKBOX_STYLES[state] ? state : '_custom'
  const style = TASK_CHECKBOX_STYLES[key] ?? EMPTY_STYLE
  return (
    <div
      className={cn('task-checkbox size-[1em] rounded border-2', style.className)}
      data-testid={style.testId}
    >
      {style.icon?.()}
    </div>
  )
}

/**
 * A task's checkbox: in a block, and in the Due panel and Agenda rows, which
 * draw a task's state with this same control (#6544).
 */
export function TaskMarkerButton({
  blockId,
  todoState,
  onToggleTodo,
}: {
  blockId: string
  todoState: string
  onToggleTodo?: ((blockId: string) => void) | undefined
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="task-marker flex-shrink-0 p-0.5 focus-ring-visible active:scale-95 touch-target max-sm:flex max-sm:items-center max-sm:justify-center"
          data-testid="task-marker"
          // #1498: keep editor focus on click (see collapse-toggle note).
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onToggleTodo?.(blockId)
          }}
          // A list row opens its block on Enter or Space; this key is the toggle's.
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
          }}
          aria-label={t('block.taskCycle', { state: todoState })}
        >
          <TaskCheckbox state={todoState} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {t('block.todoCycleTip', { state: todoState })}
      </TooltipContent>
    </Tooltip>
  )
}
