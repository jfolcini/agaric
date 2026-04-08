import { cva } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const priorityBadgeVariants = cva(
  'inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-xs font-bold leading-none',
  {
    variants: {
      priority: {
        '1': 'bg-priority-urgent text-priority-foreground',
        '2': 'bg-priority-high text-priority-foreground',
        '3': 'bg-priority-normal text-priority-foreground',
      },
    },
    defaultVariants: {
      priority: '3',
    },
  },
)

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
        className={cn(priorityBadgeVariants({ priority: priority as '1' | '2' | '3' }), className)}
      >
        P{priority}
      </span>
    )
  },
)
PriorityBadge.displayName = 'PriorityBadge'

export { PriorityBadge, priorityBadgeVariants }
