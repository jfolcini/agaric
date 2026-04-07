import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const alertListItemVariants = cva(
  'flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm cursor-pointer transition-colors [@media(pointer:coarse)]:min-h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
  {
    variants: {
      variant: {
        destructive: 'border-destructive/20 bg-destructive/5 hover:bg-destructive/10',
        pending: 'border-status-pending/30 bg-status-pending/30 hover:bg-status-pending/50',
      },
    },
    defaultVariants: { variant: 'destructive' },
  },
)

interface AlertListItemProps
  extends VariantProps<typeof alertListItemVariants>,
    Omit<React.ComponentProps<'li'>, 'className'> {
  className?: string
}

const AlertListItem = React.forwardRef<HTMLLIElement, AlertListItemProps>(
  ({ variant, className, ...props }, ref) => {
    return <li ref={ref} className={cn(alertListItemVariants({ variant }), className)} {...props} />
  },
)
AlertListItem.displayName = 'AlertListItem'

export { AlertListItem, alertListItemVariants }
