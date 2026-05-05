import type * as PopoverPrimitive from '@radix-ui/react-popover'
import type * as React from 'react'

import { PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * PEND-23 L9: thin wrapper around `PopoverContent` that locks menu-style
 * popovers (lists of selectable items) to a canonical width + viewport
 * clamp. The plan audit found `w-56`, `w-64`, `w-72`, and `w-80` all in
 * use across menu callsites, with several omitting `max-w-[calc(...)]`,
 * so picking one canonical class string is what gets us consistency.
 *
 * Canonical: `w-64 max-w-[calc(100vw-1.5rem)]`. Any consumer-supplied
 * `className` flows through `cn()` (tailwind-merge), so a caller that
 * passes `w-72` overrides the default — but the *default* covers ~95% of
 * menu sites without the per-callsite copy-paste.
 *
 * Intentionally NOT used by:
 *  - calendar / color-picker popovers (need `w-auto` to fit the grid)
 *  - form-style popovers (filter forms, options editors, JSON editors —
 *    they pick `w-72` / `w-56` based on field layout, not menu density)
 *  - the breadcrumb overflow popover (auto-shrinks to fit longest crumb)
 */
const MenuPopoverContent = ({
  ref,
  className,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) => {
  return (
    <PopoverContent
      ref={ref}
      className={cn('w-64 max-w-[calc(100vw-1.5rem)]', className)}
      {...props}
    />
  )
}
MenuPopoverContent.displayName = 'MenuPopoverContent'

export { MenuPopoverContent }
