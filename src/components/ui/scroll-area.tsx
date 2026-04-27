import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

// UX-226: Added optional `orientation` + `viewportRef` / `viewportClassName`
// / `viewportProps` props so ScrollArea can be used as the one-and-only
// scroll primitive per AGENTS.md § "Mandatory patterns" (ScrollArea for
// every scrollable container, bare `overflow-*` forbidden). Defaults
// preserve the prior vertical-only behaviour — all existing call-sites
// continue to work unchanged.
type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** Which scrollbar(s) to render. Defaults to 'vertical' for backward compat. */
  orientation?: 'vertical' | 'horizontal' | 'both' | undefined
  /**
   * Ref to the scroll viewport (the element that actually scrolls). Needed by
   * virtualization libraries (@tanstack/react-virtual, etc.) that must observe
   * the real scroll element rather than the outer Root.
   */
  viewportRef?: React.Ref<HTMLDivElement> | undefined
  /** Extra classes applied to the viewport (e.g. padding that must live inside the scroller). */
  viewportClassName?: string | undefined
  /**
   * Extra props applied to the viewport (e.g. role, tabIndex, aria-label
   * for listbox semantics; arbitrary `data-*` attributes for test or
   * styling hooks). The intersection with `Record<...>` lets callers
   * thread `data-*` flags without `as` casts at the callsite — Radix's
   * generated viewport prop type doesn't include an index signature for
   * `data-*` even though they're valid HTML.
   */
  viewportProps?:
    | (React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport> & {
        [dataAttr: `data-${string}`]: string | undefined
      })
    | undefined
}

const ScrollArea = ({
  ref,
  className,
  children,
  orientation = 'vertical',
  viewportRef,
  viewportClassName,
  viewportProps,
  ...props
}: ScrollAreaProps) => {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        {...viewportProps}
        className={cn(
          'size-full rounded-[inherit] transition-[color,box-shadow] outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1',
          viewportClassName,
          viewportProps?.className,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {(orientation === 'vertical' || orientation === 'both') && (
        <ScrollBar orientation="vertical" />
      )}
      {(orientation === 'horizontal' || orientation === 'both') && (
        <ScrollBar orientation="horizontal" />
      )}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}
ScrollArea.displayName = 'ScrollArea'

const ScrollBar = ({
  ref,
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) => {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' &&
          'h-full w-2.5 border-l border-l-transparent [@media(pointer:coarse)]:w-4',
        orientation === 'horizontal' &&
          'h-2.5 flex-col border-t border-t-transparent [@media(pointer:coarse)]:h-4',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}
ScrollBar.displayName = 'ScrollBar'

export { ScrollArea, ScrollBar }
