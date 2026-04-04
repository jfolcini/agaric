import type React from 'react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon?: React.ComponentType<Record<string, unknown>> | undefined
  message: string
  description?: string | undefined
  action?: React.ReactNode | undefined
  compact?: boolean | undefined
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
      <h2 className="text-sm font-medium">{message}</h2>
      {description && <p className="mt-1">{description}</p>}
      {action}
    </div>
  )
}
