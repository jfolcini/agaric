/**
 * CardButton — shared full-width card-style button.
 *
 * Used for interactive cards like search results and recent-page links.
 * Renders a bordered card with hover/focus styling and left-aligned text.
 *
 * Supports `asChild` polymorphism (Radix `Slot`) so consumers can render
 * the same chrome as an `<a>` / `<Link>` for navigable cards while
 * keeping the default `<button type="button">` semantics.
 */

import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

type CardButtonProps = React.ComponentProps<'button'> & { asChild?: boolean }

const CardButton = ({ ref, className, asChild = false, ...props }: CardButtonProps) => {
  const Comp = asChild ? Slot.Root : 'button'
  // `type="button"` is only valid on the native button; when rendering
  // via Slot the caller's element (e.g. `<a>`) owns its own semantics.
  const buttonOnlyProps = asChild ? {} : { type: 'button' as const }

  return (
    <Comp
      ref={ref}
      data-slot="card-button"
      className={cn(
        'w-full cursor-pointer rounded-lg border bg-card p-4 text-left hover:bg-accent/50 [@media(pointer:coarse)]:min-h-11 focus-ring-visible',
        className,
      )}
      {...buttonOnlyProps}
      {...props}
    />
  )
}
CardButton.displayName = 'CardButton'

export { CardButton }
