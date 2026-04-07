/**
 * ListItem — shared interactive list-item with hover highlight.
 *
 * Standardizes the `group flex items-center gap-3 rounded-lg …
 * hover:bg-accent/50` pattern used across TagList, PropertiesView,
 * and PageBrowser.
 */

import * as React from 'react'

import { cn } from '@/lib/utils'

const ListItem = React.forwardRef<HTMLLIElement, React.ComponentProps<'li'>>(
  ({ className, ...props }, ref) => {
    return (
      <li
        ref={ref}
        data-slot="list-item"
        className={cn(
          'group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent/50 [@media(pointer:coarse)]:min-h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          className,
        )}
        {...props}
      />
    )
  },
)
ListItem.displayName = 'ListItem'

export { ListItem }
