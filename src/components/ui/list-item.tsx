/**
 * ListItem — shared interactive list-item with hover highlight.
 *
 * Standardizes the `group flex items-center gap-3 rounded-lg …
 * hover:bg-accent/50` pattern used across TagList and PageBrowser.
 *
 * Supports `asChild` polymorphism (Radix `Slot`) so consumers can render
 * the chrome as an `<a>` for navigable lists while keeping the default
 * `<li>` semantics.
 */

import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

type ListItemProps = React.ComponentProps<'li'> & { asChild?: boolean }

const ListItem = ({ ref, className, asChild = false, ...props }: ListItemProps) => {
  const Comp = asChild ? Slot.Root : 'li'
  return (
    <Comp
      ref={ref}
      data-slot="list-item"
      className={cn(
        'group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent/50 [@media(pointer:coarse)]:min-h-11 focus-ring-visible',
        className,
      )}
      {...props}
    />
  )
}
ListItem.displayName = 'ListItem'

export { ListItem }
