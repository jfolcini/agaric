/**
 * CardButton — shared full-width card-style button.
 *
 * Used for interactive cards like search results and recent-page links.
 * Renders a bordered card with hover/focus styling and left-aligned text.
 */

import type * as React from 'react'

import { cn } from '@/lib/utils'

function CardButton({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-slot="card-button"
      className={cn(
        'w-full cursor-pointer rounded-lg border bg-card p-4 text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
      {...props}
    />
  )
}

export { CardButton }
