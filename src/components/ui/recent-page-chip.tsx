/**
 * RecentPageChip — chip primitive for the desktop "Recently visited" strip.
 *
 * Purpose-built `<button>` (NOT a `Button` ghost variant): the row of MRU
 * chips needs visible rest-state chrome — border + faint secondary tint —
 * so the strip telegraphs "row of clickable navigation items" before the
 * pointer arrives. `Button variant="ghost"` is the inverse pattern (chrome
 * fades into the background until hover) and was the wrong rest-state for
 * a row the user is *expected* to scan (PEND-19).
 *
 * `shrink-0` on the chip prevents flex-children from compressing chip
 * widths when the row overflows; the parent `<ScrollArea orientation="horizontal">`
 * in `RecentPagesStrip` is what surfaces the overflow (PEND-32).
 *
 * Class composition mirrors the CVA pattern used by Badge / Button (single
 * base class string composed via `cn()`); this chip has only one variant
 * so we skip the `cva()` factory and pin the classes inline.
 */

import type React from 'react'
import { cn } from '@/lib/utils'

export type RecentPageChipProps = React.ComponentProps<'button'>

const chipClass = cn(
  // base
  'inline-flex h-7 min-w-0 max-w-[160px] shrink-0 items-center gap-1.5',
  'rounded-md border px-2.5 text-xs',
  'transition-colors',
  // touch — AGENTS.md "Mandatory patterns" 44 px floor on coarse pointers.
  // The strip is also gated by `useIsMobile()` (returns null on mobile),
  // but hybrid pointer devices (touch laptops, tablets in desktop mode)
  // pass that gate while still reporting `pointer: coarse`. Scale the
  // chip explicitly so the touch target stays compliant.
  '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-3',
  // rest state — visible chrome
  'border-border/60 bg-secondary/40 text-muted-foreground',
  // hover — clearer interactive state
  'hover:border-accent hover:bg-accent hover:text-accent-foreground',
  // focus — standard 3 px ring per AGENTS.md (this is a chip, not a link)
  'focus-ring-visible',
  // UX-284 keyboard-traversal indicator
  'focus-visible:bg-accent/60',
)

export function RecentPageChip({
  ref,
  className,
  type = 'button',
  ...props
}: RecentPageChipProps): React.ReactElement {
  return (
    <button
      ref={ref}
      type={type}
      data-slot="recent-page-chip"
      className={cn(chipClass, className)}
      {...props}
    />
  )
}
