import * as React from 'react'
import { priorityColor } from '@/lib/priority-color'
import { cn } from '@/lib/utils'

/**
 * Badge showing a priority level. Used across the agenda/block UIs.
 *
 * UX-201b: the set of priority levels is user-configurable
 * (see `priority-levels.ts`). The colour is chosen index-based by
 * `priorityColor`; the label is always `P{priority}` so any string
 * key (numeric or alpha) renders correctly.
 *
 * Layout matches the original CVA base: a compact inline-flex pill with
 * bold text and `focus-visible:ring-*` parity with Button/Input.
 */

const BASE_CLASSES =
  'inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-xs font-bold leading-none'

interface PriorityBadgeProps {
  priority: string
  className?: string
}

const PriorityBadge = React.forwardRef<HTMLSpanElement, PriorityBadgeProps>(
  ({ priority, className }, ref) => {
    return (
      <span
        ref={ref}
        data-slot="priority-badge"
        className={cn(BASE_CLASSES, priorityColor(priority), className)}
      >
        P{priority}
      </span>
    )
  },
)
PriorityBadge.displayName = 'PriorityBadge'

export { PriorityBadge }
