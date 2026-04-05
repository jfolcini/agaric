/**
 * ListItem — shared interactive list-item with hover highlight.
 *
 * Standardizes the `group flex items-center gap-3 rounded-lg …
 * hover:bg-accent/50` pattern used across TagList, PropertiesView,
 * and PageBrowser.
 */

import type * as React from 'react'

import { cn } from '@/lib/utils'

function ListItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="list-item"
      className={cn(
        'group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent/50',
        className,
      )}
      {...props}
    />
  )
}

export { ListItem }
