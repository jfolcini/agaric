/**
 * StatusIcon -- shared icon component for todo states.
 *
 * Maps todo_state to the corresponding Lucide icon:
 *   DOING      -> Clock       (text-task-doing)
 *   DONE       -> CheckCircle2 (text-task-done)
 *   CANCELLED  -> XCircle     (text-task-cancelled / muted)
 *   TODO       -> Circle      (text-muted-foreground)
 *
 * When `showDone` is false, returns null for DONE state
 * (used by UnfinishedTasks which only shows TODO/DOING).
 *
 * `size` (`sm` | `md` | `lg`, default `md`) scales the icon for dense list
 * rows or larger header chips. Modeled after `Spinner`'s CVA size variants.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { CheckCircle2, Circle, Clock, XCircle } from 'lucide-react'
import type React from 'react'

import { cn } from '@/lib/utils'

const statusIconVariants = cva('shrink-0', {
  variants: {
    size: {
      sm: 'h-3 w-3',
      md: 'h-4 w-4',
      lg: 'h-5 w-5',
    },
  },
  defaultVariants: {
    size: 'md',
  },
})

export interface StatusIconProps extends VariantProps<typeof statusIconVariants> {
  /** The todo state to render an icon for. */
  state: string | null
  /** Whether to show the DONE icon. Defaults to true. Set to false to hide DONE state. */
  showDone?: boolean
}

/** Return the appropriate status icon component for a todo_state. */
export function StatusIcon({
  state,
  showDone = true,
  size,
}: StatusIconProps): React.ReactElement | null {
  if (state === 'DONE' && !showDone) return null

  const sizeClass = statusIconVariants({ size })

  if (state === 'DOING')
    return (
      <Clock
        data-slot="status-icon"
        className={cn(sizeClass, 'text-task-doing')}
        aria-hidden="true"
        data-testid="icon-doing"
      />
    )
  if (state === 'DONE')
    return (
      <CheckCircle2
        data-slot="status-icon"
        className={cn(sizeClass, 'text-task-done')}
        aria-hidden="true"
        data-testid="icon-done"
      />
    )
  if (state === 'CANCELLED')
    return (
      <XCircle
        data-slot="status-icon"
        className={cn(sizeClass, 'text-task-cancelled')}
        aria-hidden="true"
        data-testid="icon-cancelled"
      />
    )
  // Default: TODO or unknown
  return (
    <Circle
      data-slot="status-icon"
      className={cn(sizeClass, 'text-muted-foreground')}
      aria-hidden="true"
      data-testid="icon-todo"
    />
  )
}

export { statusIconVariants }
