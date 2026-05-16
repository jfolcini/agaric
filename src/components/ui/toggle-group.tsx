/**
 * ToggleGroup — segmented control built on Radix `react-toggle-group`.
 *
 * Thin wrapper consistent with the other `src/components/ui/*` primitives
 * (Sheet, Select): re-exports `Root` / `Item` with shared classNames so
 * callers don't repeat the pill / border / focus styles. Single-select
 * by default; pass `type="multiple"` for multi-select.
 *
 * Used by the per-block history panel (PEND-17 Part B) for the
 * t('history.diffMode.justThisChange') / t('history.diffMode.comparedToCurrent')
 * diff-mode switcher.
 */

'use client'

import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn(
        'inline-flex items-center rounded-md border border-input bg-background p-0.5',
        className,
      )}
      {...props}
    />
  )
}
ToggleGroup.displayName = 'ToggleGroup'

function ToggleGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex items-center justify-center rounded-sm px-3 py-1 text-xs font-medium',
        // Touch-target compliance (AGENTS.md: ≥44px on coarse pointers).
        // Desktop keeps the compact inline-pill height; coarse pointers
        // get a 44px minimum tap area without affecting the visual height
        // of the surrounding segmented control on desktop.
        '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-4',
        'text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-ring-visible',
        'data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:shadow-sm',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
ToggleGroupItem.displayName = 'ToggleGroupItem'

export { ToggleGroup, ToggleGroupItem }
