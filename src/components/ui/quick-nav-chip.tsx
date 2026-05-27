/**
 * QuickNavChip — destination chip primitive for the desktop `QuickAccessBar`.
 *
 * Mirrors `recent-page-chip.tsx` chrome (h-7 mouse, h-11 coarse-pointer touch
 * target, same focus ring, transition palette) so the two zones of the
 * quick-access bar share a visual language; the differences are deliberate:
 *
 *  - **icon + label** instead of text-only — destinations identify themselves
 *    via their sidebar icon, the recents zone stays text-only (different
 *    "language": nav chrome vs history).
 *  - **active state** — when the chip's `active` prop is true the rest-state
 *    chrome flips to an accent tint and the caller is expected to also pass
 *    `aria-current="page"` (the chip doesn't infer the ARIA attribute on its
 *    own — `aria-current` is intentionally a separate prop so consumers can
 *    decide between `'page'`, `'location'`, etc.).
 *
 * No `asChild` polymorphism — destinations are always view-switch buttons,
 * never anchors (views aren't URLs in this app's routing model).
 */

import type React from 'react'
import { cn } from '@/lib/utils'

export interface QuickNavChipProps extends React.ComponentProps<'button'> {
  /** Whether this destination is the current view; flips the chip to the active palette. */
  active?: boolean
}

const baseChipClass = cn(
  // base geometry — mirrors RecentPageChip
  'inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5',
  'rounded-md border px-2.5 text-xs',
  'transition-colors',
  // touch — AGENTS.md "Mandatory patterns" 44 px floor on coarse pointers.
  // The bar is gated by `useIsMobile()` (returns null on mobile), but
  // hybrid pointer devices (touch laptops, tablets in desktop mode) pass
  // that gate while still reporting `pointer: coarse`. Scale the chip
  // explicitly so the touch target stays compliant.
  '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:px-3',
  // focus — standard 3 px ring per AGENTS.md
  'focus-ring-visible',
  // keyboard-traversal indicator (UX-284 parity with RecentPageChip)
  'focus-visible:bg-accent/60',
)

const restClass = cn(
  // rest state — visible chrome, same baseline as RecentPageChip
  'border-border/60 bg-secondary/40 text-muted-foreground',
  // hover — clearer interactive state
  'hover:border-accent hover:bg-accent hover:text-accent-foreground',
)

const activeClass = cn(
  // active state — accent palette so the current destination is visible
  // without ambiguity. `aria-current="page"` is set by the caller.
  'border-accent bg-accent text-accent-foreground',
  'hover:bg-accent hover:text-accent-foreground',
)

export function QuickNavChip({
  ref,
  className,
  type = 'button',
  active = false,
  ...props
}: QuickNavChipProps): React.ReactElement {
  return (
    <button
      ref={ref}
      type={type}
      data-slot="quick-nav-chip"
      data-active={active ? 'true' : undefined}
      className={cn(baseChipClass, active ? activeClass : restClass, className)}
      {...props}
    />
  )
}
