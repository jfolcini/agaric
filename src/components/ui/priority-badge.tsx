import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
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
 *
 * `size` (`sm` | `md` | `lg`, default `md`) scales the badge for dense list
 * rows or larger header chips. Modeled after `Spinner`'s CVA size variants.
 */

const priorityBadgeVariants = cva(
  'inline-flex items-center justify-center rounded font-bold leading-none',
  {
    variants: {
      size: {
        sm: 'h-3.5 min-w-3.5 px-0.5 text-xs',
        md: 'h-4 min-w-4 px-1 text-xs',
        lg: 'h-6 min-w-6 px-2 text-sm',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  },
)

interface PriorityBadgeProps extends VariantProps<typeof priorityBadgeVariants> {
  priority: string
  className?: string
  ref?: React.Ref<HTMLSpanElement>
}

const PriorityBadge = ({ ref, priority, size, className }: PriorityBadgeProps) => {
  return (
    <span
      ref={ref}
      data-slot="priority-badge"
      className={cn(priorityBadgeVariants({ size }), priorityColor(priority), className)}
    >
      P{priority}
    </span>
  )
}
PriorityBadge.displayName = 'PriorityBadge'

export { PriorityBadge, priorityBadgeVariants }
