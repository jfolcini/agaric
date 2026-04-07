import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const statusBadgeVariants = cva('shrink-0 rounded px-1 py-0.5 text-xs font-bold leading-none', {
  variants: {
    state: {
      DONE: 'bg-status-done text-status-done-foreground',
      DOING: 'bg-status-active text-status-active-foreground',
      TODO: 'bg-status-pending text-status-pending-foreground',
      default: 'bg-status-pending text-status-pending-foreground',
      overdue: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    },
  },
  defaultVariants: { state: 'default' },
})

interface StatusBadgeProps extends VariantProps<typeof statusBadgeVariants> {
  children: React.ReactNode
  className?: string
}

export function StatusBadge({ state, children, className }: StatusBadgeProps) {
  return <span className={cn(statusBadgeVariants({ state }), className)}>{children}</span>
}

export { statusBadgeVariants }
