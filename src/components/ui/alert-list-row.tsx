import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * AlertListRow — a clickable row inside an alert section list
 * (overdue / upcoming). Renamed from `AlertListItem` to break the
 * badge-naming collision flagged by UX item 4. The shape is a list
 * `<li>` row, not a badge-shaped item, so "row" is the accurate noun.
 */

const alertListRowVariants = cva(
  'flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm cursor-pointer transition-colors [@media(pointer:coarse)]:min-h-11 focus-ring-visible',
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

interface AlertListRowProps
  extends VariantProps<typeof alertListRowVariants>,
    Omit<React.ComponentProps<'li'>, 'className'> {
  className?: string
  asChild?: boolean
}

const AlertListRow = ({
  ref,
  variant,
  className,
  asChild = false,
  ...props
}: AlertListRowProps) => {
  const Comp = asChild ? Slot.Root : 'li'
  return (
    <Comp
      ref={ref}
      data-slot="alert-list-row"
      className={cn(alertListRowVariants({ variant }), className)}
      {...props}
    />
  )
}
AlertListRow.displayName = 'AlertListRow'

export { AlertListRow, alertListRowVariants }
