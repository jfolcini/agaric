import type React from 'react'

import { cn } from '@/lib/utils'

/**
 * Element used to render the message. Defaults to `h2`.
 *
 * Use a lower heading level (`h3`–`h6`) when the EmptyState is nested under an
 * existing heading, or a non-heading element (`p`) when the surface already owns
 * its heading and an additional heading would skip levels / flatten the outline.
 */
type EmptyStateHeadingLevel = 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p'

interface EmptyStateProps {
  icon?: React.ComponentType<Record<string, unknown>> | undefined
  message: string
  description?: string | undefined
  action?: React.ReactNode | undefined
  compact?: boolean | undefined
  /**
   * Element used to render the message. Defaults to `h2` to preserve existing
   * behavior. Pass a lower heading level or `p` to avoid heading-order
   * violations when the EmptyState sits under an existing heading.
   */
  headingLevel?: EmptyStateHeadingLevel | undefined
}

export function EmptyState({
  icon: Icon,
  message,
  description,
  action,
  compact,
  headingLevel = 'h2',
}: EmptyStateProps): React.ReactElement {
  const Heading = headingLevel
  return (
    <section
      aria-label={message}
      className={cn('text-center text-sm text-muted-foreground', compact ? 'p-6' : 'p-8')}
    >
      {Icon && (
        <div className="mx-auto mb-2 flex size-8 items-center justify-center rounded-full bg-muted [&>svg]:size-4">
          <Icon />
        </div>
      )}
      <Heading className="text-sm font-medium">{message}</Heading>
      {description && <p className="mt-1">{description}</p>}
      {action}
    </section>
  )
}
