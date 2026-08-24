import { Popover as PopoverPrimitive } from 'radix-ui'
import type * as React from 'react'

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
// The Radix var is already keyboard-aware, and this is the whole fix — do NOT
// also feed the keyboard height in as bottom `collisionPadding`, which
// subtracts it a second time (see the note on `EDGE_PADDING_PX` below).
// `PopperContent` positions with `strategy: 'fixed'` and no `collisionBoundary`
// (`@radix-ui/react-popper` 1.3.7), so `detectOverflow` falls through to
// `rootBoundary: 'viewport'` → `@floating-ui/dom`'s `getViewportRect`, which
// takes its width/height from `window.visualViewport` whenever that API exists
// (`floating-ui.dom.mjs`, `getViewportRect`) — the VISUAL viewport, i.e. the
// keyboard-free band, in the exact same layout-viewport coordinates
// `computeKeyboardInset` works in (`y = vv.offsetTop`, `height = vv.height`).
// `JournalCalendarDropdown` flips against the same signal by hand.
//
// Nor does the primitive need its own `visualViewport` subscription to stay
// current: `autoUpdate` (which Radix wires up) treats `window.visualViewport`
// as an overflow ancestor and listens to its `resize`/`scroll`, so a popover
// that is already open when the IME rises re-runs `size()` too.
//
// The `calc(100dvh-4rem)` fallback keeps a sane cap where the var has no value
// yet. That is jsdom/happy-dom, where nothing ever lays the popper out enough
// to run `size()`'s `apply` — and also the FIRST paint of every popover in a
// real browser, since Radix sets the var as an inline alias of
// `var(--radix-popper-available-height)`, which is unresolvable until `size()`
// has run once. It is NOT `avoidCollisions={false}`: in
// `@radix-ui/react-popper`, `avoidCollisions` only gates the `shift`/`flip`
// middleware, while the `size()` middleware that sets this var runs
// unconditionally.
const POPOVER_CONTENT_BASE =
  'bg-popover text-popover-foreground z-50 w-72 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height,calc(100dvh-4rem))] overflow-y-auto overscroll-contain rounded-md border p-4 shadow-(--shadow-floating) outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2'

/**
 * Default collision padding: 4px, so a popover never sits flush against an edge
 * of the visible viewport (including, on touch, the top edge of the keyboard).
 *
 * This must NOT carry the soft-keyboard height (#4313). The keyboard is already
 * outside the collision boundary — floating-ui measures that boundary with
 * `visualViewport` — and `size()` subtracts BOTH vertical paddings from the
 * available height regardless of which side the popover lands on:
 * `maximumClippingHeight = height - overflow.top - overflow.bottom`, which
 * telescopes to `clippingHeight - paddingTop - paddingBottom`
 * (`@floating-ui/core`, `size`; `detectOverflow` folds `paddingObject` into
 * both overflows). `availableHeight` is then
 * `min(height - overflow[heightSide], maximumClippingHeight)` — the `min()`
 * is what picks the doubly-subtracted term up. (Not, as an earlier revision of
 * this comment claimed, because `shift` forces `maximumClippingHeight` outright
 * on vertical placements: for `top`/`bottom` the main shift axis is x, so
 * `shift.enabled.y` is false. The measurement settles it — at the geometry
 * below the "outright" reading predicts 356px and the `min()` reading 310px,
 * against 311px measured.)
 *
 * Adding the keyboard here therefore subtracted it twice: on an iPhone-13
 * viewport with a 300px keyboard the cap collapsed to 56px — one row — for
 * EVERY popover opened with the IME up, and where the keyboard covers more
 * than half the visible band the value goes negative and the browser drops the
 * `max-height` declaration entirely.
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
  collisionPadding = EDGE_PADDING_PX,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(POPOVER_CONTENT_BASE, className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
)

PopoverContent.displayName = 'PopoverContent'

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
