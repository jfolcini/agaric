import type React from 'react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>
  message: string
  description?: string
  action?: React.ReactNode
  compact?: boolean
}

export function EmptyState({
  icon: Icon,
  message,
  description,
  action,
  compact,
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'rounded-lg border border-dashed text-center text-sm text-muted-foreground',
        compact ? 'p-6' : 'p-8',
      )}
    >
      {Icon && <Icon className="mx-auto mb-2 h-5 w-5" />}
      <p>{message}</p>
      {description && <p className="mt-1">{description}</p>}
      {action}
    </div>
  )
}
