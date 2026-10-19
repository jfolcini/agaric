/**
 * ToggleGroup — the segmented control for a one-of-N choice (#5921), on Radix
 * `react-toggle-group` with `type="single"`: a `radiogroup` of `radio`s.
 *
 * The selected segment is `bg-secondary text-foreground` inside a
 * `border-foreground` outline. The fill alone sits about 1.1:1 from the track;
 * the outline is the 3:1 cue (pinned in `theme-contrast.test.ts`). The track
 * stays `bg-background`: the unselected labels are `text-muted-foreground`,
 * which falls under 4.5:1 on `--muted` in Dracula, Solarized Dark and One Dark
 * Pro. The look is keyed on `aria-checked`, not `data-state`, because a
 * `TooltipTrigger asChild` writes its own `data-state` over the item's.
 *
 * Keyboard, per the APG radio group: Tab reaches the checked segment, and an
 * arrow key (or Home / End) moves focus and the selection together. Radix's
 * roving focus only moves focus, so the group checks the segment it focused.
 *
 * Radix reports pressing the checked segment again as `''`; callers ignore it.
 */

'use client'

import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import type * as React from 'react'
import { useRef } from 'react'

import { cn } from '@/lib/utils'

/** The keys Radix's roving focus moves focus with. */
const ROVING_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

function ToggleGroup({
  className,
  onKeyDown,
  onFocus,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  // Roving focus moves focus in a timeout after the keydown, so the focus
  // handler learns from this flag that a roving key, not Tab or a click, moved it.
  const rovingKeyRef = useRef(false)
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn(
        'inline-flex items-center rounded-md border border-input bg-background p-0.5',
        className,
      )}
      onKeyDown={(event) => {
        rovingKeyRef.current = ROVING_KEYS.has(event.key)
        onKeyDown?.(event)
      }}
      onFocus={(event) => {
        const target = event.target
        if (
          rovingKeyRef.current &&
          props.type === 'single' &&
          target instanceof HTMLElement &&
          target.getAttribute('role') === 'radio' &&
          target.getAttribute('aria-checked') === 'false'
        ) {
          target.click()
        }
        rovingKeyRef.current = false
        onFocus?.(event)
      }}
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
        'inline-flex items-center justify-center rounded-sm border border-transparent px-3 py-1 text-xs font-medium',
        // Touch-target compliance (AGENTS.md: ≥44px on coarse pointers).
        // Desktop keeps the compact inline-pill height; coarse pointers
        // get a 44px minimum tap area without affecting the visual height
        // of the surrounding segmented control on desktop.
        '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-4',
        'text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-ring-visible',
        'aria-checked:border-foreground aria-checked:bg-secondary aria-checked:text-foreground',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
ToggleGroupItem.displayName = 'ToggleGroupItem'

export { ToggleGroup, ToggleGroupItem }
