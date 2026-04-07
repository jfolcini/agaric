import * as React from 'react'

import { priorityColor } from '@/lib/priority-color'
import { cn } from '@/lib/utils'

interface PriorityBadgeProps {
  priority: string
  className?: string
}

const PriorityBadge = React.forwardRef<HTMLSpanElement, PriorityBadgeProps>(
  ({ priority, className }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-xs font-bold leading-none',
          priorityColor(priority),
          className,
        )}
      >
        P{priority}
      </span>
    )
  },
)
PriorityBadge.displayName = 'PriorityBadge'

export { PriorityBadge }
