import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const statusBadgeVariants = cva('shrink-0 rounded px-1 py-0.5 text-xs font-bold leading-none', {
  variants: {
    state: {
      DONE: 'bg-status-done text-status-done-foreground',
      DOING: 'bg-status-active text-status-active-foreground',
      TODO: 'bg-status-pending text-status-pending-foreground',
      default: 'bg-status-pending text-status-pending-foreground',
      overdue: 'bg-alert-warning text-alert-warning-foreground',
    },
  },
  defaultVariants: { state: 'default' },
})

interface StatusBadgeProps extends VariantProps<typeof statusBadgeVariants> {
  children: React.ReactNode
  className?: string
}

const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ state, children, className }, ref) => {
    return (
      <span ref={ref} className={cn(statusBadgeVariants({ state }), className)}>
        {children}
      </span>
    )
  },
)
StatusBadge.displayName = 'StatusBadge'

export { StatusBadge, statusBadgeVariants }
