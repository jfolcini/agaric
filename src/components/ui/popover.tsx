import { Popover as PopoverPrimitive } from 'radix-ui'
import type * as React from 'react'

import { useSoftKeyboardInset } from '@/hooks/useSoftKeyboardInset'
import { cn } from '@/lib/utils'

// PERF: hoisted from an inline string in render — twMerge then only re-parses
// the caller's `className` rather than this whole base on every render.
//
// #1960 — `overflow-y-auto overscroll-contain` makes every popover scroll with
// wheel/touch when its content exceeds the cap. `overscroll-contain` stops the
// scroll gesture from chaining to the page behind the menu.
//
// #4313 — the cap is `--radix-popover-content-available-height`, NOT
// `100dvh`. The original `max-h-[calc(100dvh-4rem)]` was written believing
// "`dvh` tracks the soft keyboard"; it does not. On Android (edge-to-edge /
// targetSdk 36) the IME shrinks only the VISUAL viewport, so `dvh`, `vh` and
// `innerHeight` all keep reporting the full screen — which is precisely the
// fact `computeKeyboardInset` is built on (`lib/keyboard-inset.ts` derives the
// keyboard height as `innerHeight - (vv.height + vv.offsetTop)`, which would be
// 0 if `dvh` shrank). Measured on a Pixel 8: the Turn-into popover grew to
// ~850 CSS px inside a 914 px layout viewport whose bottom ~420 px was
// keyboard, so its top third rendered ABOVE the screen edge and its rows were
// unreachable — scrolling could not bring them back, because the container
// itself was clipped.
//
// Radix computes the available-height var from the anchor position and the
// collision boundary, so honouring it (plus the keyboard collision padding
// below) bounds the popover to space that is actually on screen. The
// `calc(100dvh-4rem)` fallback keeps a sane cap where the var is unset — in
// practice that's jsdom/happy-dom, where nothing ever lays the popper out
// enough to run `size()`'s `apply`. It is NOT `avoidCollisions={false}`: in
// `@radix-ui/react-popper`, `avoidCollisions` only gates the `shift`/`flip`
// middleware, while the `size()` middleware that sets this var runs
// unconditionally. `AddFilterPopover` already used this var directly; the
// primitive now does it for every popover.
const POPOVER_CONTENT_BASE =
  'bg-popover text-popover-foreground z-50 w-72 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height,calc(100dvh-4rem))] overflow-y-auto overscroll-contain rounded-md border p-4 shadow-(--shadow-floating) outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2'

/**
 * Default collision padding on the sides that don't touch the keyboard: 4px
 * so a popover never sits flush against an edge.
 */
const EDGE_PADDING_PX = 4

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
  collisionPadding,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) => {
  // 0 on desktop, in jsdom, and whenever the keyboard is closed, so this is
  // inert everywhere except the case it exists for.
  const keyboardInset = useSoftKeyboardInset()

  // Keyboard collision padding (#4313).
  //
  // The soft keyboard is not part of any collision boundary the browser knows
  // about — to Radix the viewport is still full height — so a popover anchored
  // near the bottom (the pinned editor toolbar is exactly there) is happily
  // placed into the keyboard, invisible and untappable. Reporting the keyboard as
  // bottom padding makes Radix's own flip/shift logic route around it and shrinks
  // `--radix-popover-content-available-height` to match.
  //
  // An explicit `collisionPadding` from a caller wins on the sides it names,
  // but the keyboard still has to be accounted for: a caller asking for room
  // at the bottom cannot know how much of it the IME is currently eating.
  const resolvedPadding =
    typeof collisionPadding === 'number'
      ? {
          top: collisionPadding,
          right: collisionPadding,
          left: collisionPadding,
          bottom: collisionPadding + keyboardInset,
        }
      : {
          top: collisionPadding?.top ?? EDGE_PADDING_PX,
          right: collisionPadding?.right ?? EDGE_PADDING_PX,
          left: collisionPadding?.left ?? EDGE_PADDING_PX,
          bottom: (collisionPadding?.bottom ?? EDGE_PADDING_PX) + keyboardInset,
        }

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={resolvedPadding}
        className={cn(POPOVER_CONTENT_BASE, className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

PopoverContent.displayName = 'PopoverContent'

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
