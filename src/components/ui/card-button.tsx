/**
 * CardButton — shared full-width card-style button.
 *
 * Used for interactive cards like search results and recent-page links.
 * Renders a bordered card with hover/focus styling and left-aligned text.
 */

import * as React from 'react'

import { cn } from '@/lib/utils'

const CardButton = React.forwardRef<HTMLButtonElement, React.ComponentProps<'button'>>(
  ({ className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        data-slot="card-button"
        className={cn(
          'w-full cursor-pointer rounded-lg border bg-card p-4 text-left hover:bg-accent/50 [@media(pointer:coarse)]:min-h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          className,
        )}
        {...props}
      />
    )
  },
)
CardButton.displayName = 'CardButton'

export { CardButton }
