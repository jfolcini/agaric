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
//
// The outer `max(…, 8rem)` closes two related gaps found in review of the fix
// above:
//
// - A negative available height is not "unset" for CSS var-fallback
//   purposes: `var(--x, fallback)` only substitutes `fallback` when `--x` is
//   guaranteed-invalid, not when it holds a valid-but-negative length.
//   floating-ui's `size()` does not clamp `availableHeight` to zero, so once
//   the anchor has scrolled far enough past the visible viewport that
//   `height - overflow.bottom` goes negative, Radix writes something like
//   `--radix-popper-available-height: -40px`, and `max-height: -40px` is
//   invalid at *computed-value* time — the whole declaration drops, and the
//   popover renders with no cap at all (worse off than the `100dvh-4rem`
//   fallback it would otherwise get). `max(negative, 8rem)` always resolves
//   to `8rem` in that case, so a cap always survives.
// - Even in the ordinary, non-negative case, nothing floors how small
//   `size()` is allowed to shrink the cap near a viewport edge. `max()` puts
//   a floor under it: the popover stops shrinking at the floor and becomes
//   scrollable (`overflow-y-auto`, already set below) instead of collapsing
//   to a sliver.
//
//   That second one is a deliberate TRADEOFF, not a free win, and the
//   mechanism that would make it free is not wired here. An earlier revision
//   of this comment claimed `avoidCollisions`/`shift` "still keep it
//   on-screen" when the floor exceeds the band the popover has to fit in.
//   They do not: Radix wires `shift({mainAxis: true, crossAxis: false})`, and
//   for `top`/`bottom` placements the main axis is x — the same fact the
//   `EDGE_PADDING_PX` note below already turns on — so `shift` never moves
//   content vertically, and `flip` only swaps sides, it does not make an
//   over-tall box fit. So on a landscape phone with the IME up (a visible band
//   of ~190px) a popover anchored mid-band renders at the 128px floor and is
//   clipped, instead of shrinking to the ~80px that would have fit.
//   Still strictly better than the `100dvh` cap this replaced — that one
//   measured against the whole screen, keyboard included, and overshot by
//   hundreds of px — so the floor stays. But it stays as a documented
//   tradeoff: the floor buys a usable menu in the common case and pays for it
//   with clipping in a genuinely tiny band.
//
// 8rem (128px) is the smallest box that can still show two coarse-pointer
// rows: 2 × 44px + this primitive's own `p-4` (32px) + 1px borders = 122px,
// rounded up to the nearest rem step. It is deliberately NOT derived from
// `e2e/formatting-toolbar-mobile.spec.ts`'s `MIN_USABLE_POPOVER_HEIGHT`. An
// earlier revision said 8rem was picked *to clear* that constant, which had
// the dependency exactly backwards — a floor sized to satisfy an assertion
// makes the assertion unfalsifiable, and it did: with the floor in place the
// double subtraction below still rendered a 128px box and the spec's
// rendered-height check passed. That spec now asserts on the pre-floor
// `--radix-popover-content-available-height` — the value the double
// subtraction actually corrupts — so the two numbers are independent again
// and this floor cannot mask the regression it sits next to.
const POPOVER_CONTENT_BASE =
  'bg-popover text-popover-foreground z-50 w-72 max-w-[calc(100vw-2rem)] max-h-[max(var(--radix-popover-content-available-height,calc(100dvh-4rem)),8rem)] overflow-y-auto overscroll-contain rounded-md border p-4 shadow-(--shadow-floating) outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2'

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
 *
 * #4339 — before #4313 this prop was not set at all, so every call site got
 * Radix's own default of `0`. `EDGE_PADDING_PX` is a deliberate app-wide
 * change (~31 production call sites, none of which pass `collisionPadding`
 * themselves), not an incidental one, so it gets its own disposition:
 *
 * - The default itself IS pinned by a test
 *   (`__tests__/popover.test.tsx`, "defaults collisionPadding to
 *   EDGE_PADDING_PX"). It calls `PopoverContent` directly as a function and
 *   reads the element tree it returns, because `collisionPadding` isn't
 *   reflected anywhere in the rendered DOM (no attribute, no style) — it
 *   only affects floating-ui's internal geometry once `size()`/`flip`/`shift`
 *   actually run, which happy-dom never lays out enough to do (same reason
 *   the height-cap test above asserts the class expression, not a computed
 *   px value). That is deliberately narrower than "the popover sits 4px off
 *   the edge in a real browser", and NOTHING covers that wider claim —
 *   grepping `collisionPadding` and `data-side` across `e2e/` finds only
 *   comment mentions, and the one spec that touches this area asserts the
 *   available-height variable rather than the 4px inset. Stated plainly
 *   rather than deferred to "whatever end-to-end checks exist", because an
 *   unexamined elsewhere is exactly the absence-read-as-coverage this
 *   disposition exists to avoid.
 * - Whether 4px of padding flips any existing popover to a different side
 *   than it used to land on was checked and not resolved: no test in this
 *   repo asserts `data-side` for any popover, so there is no "before"
 *   behavior recorded anywhere to diff against, and reproducing it would
 *   mean measuring real layout for every call site at the specific viewport
 *   sizes/anchor positions where it opens — outside what this environment
 *   (or a targeted unit-test pass) can do. A flip only changes for a
 *   placement that was already within 4px of its threshold, which is a
 *   narrow band for the button/menu-anchored popovers this codebase has,
 *   but that is reasoning, not a measurement, and is not a substitute for
 *   one.
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
