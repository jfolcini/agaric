import { Popover as PopoverPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

// PERF: hoisted from inline string in render — twMerge only re-parses caller className.
// See pending/design-system-perf-review-2026-05-09.md Tier 3 item 16.
// #1960 — `overflow-y-auto overscroll-contain` makes every popover scroll with
// wheel/touch when its content exceeds the viewport cap (the existing
// `max-h-[calc(100dvh-4rem)]` already bounds it to the visual viewport, so
// `dvh` tracks the soft keyboard). `overscroll-contain` stops the scroll
// gesture from chaining to the page behind the menu.
const POPOVER_CONTENT_BASE =
  'bg-popover text-popover-foreground z-50 w-72 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain rounded-md border p-4 shadow-(--shadow-floating) outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2'

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}
Popover.displayName = 'Popover'

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}
PopoverTrigger.displayName = 'PopoverTrigger'

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}
PopoverAnchor.displayName = 'PopoverAnchor'

const PopoverContent = ({
  ref,
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(POPOVER_CONTENT_BASE, className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
)

PopoverContent.displayName = 'PopoverContent'

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
