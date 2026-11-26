/**
 * ToggleGroup — the segmented control for a one-of-N choice (#5921), on Radix
 * `react-toggle-group` with `type="single"`: a `radiogroup` of `radio`s.
 *
 * The selected segment is `bg-secondary text-foreground` inside a
 * `border-foreground` outline. The fill alone barely differs from the track, so
 * the outline is the 3:1 cue. The track stays `bg-background`, on which the
 * muted unselected labels keep 4.5:1; `theme-contrast.test.ts` pins both in
 * every theme. The look is keyed on `aria-checked`, not `data-state`, because a
 * `TooltipTrigger asChild` writes its own `data-state` over the item's.
 *
 * Keyboard, per the APG radio group: Tab reaches the checked segment, and an
 * arrow key (or Home / End) moves focus and the selection together. Radix's
 * roving focus only moves focus, so the group checks the segment it focused.
 *
 * Radix reports pressing the checked segment again as `''`; callers ignore it.
 */

'use client'

import { cva, type VariantProps } from 'class-variance-authority'
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

const toggleGroupVariants = cva(
  // On a coarse pointer the frame is one button high (`Button`): 32 px
  // items, a 1 px inset and the border make 36 px, at every size.
  'inline-flex items-center rounded-md border border-input bg-background p-0.5 coarse:p-px',
  {
    variants: {
      size: {
        // 32 px on a fine pointer.
        default: '',
        // 28 px on a fine pointer, as tall as an `xs` Button and a `sm` Select
        // in the same row.
        sm: '[&>[data-slot=toggle-group-item]]:py-0.5',
      },
    },
    defaultVariants: { size: 'default' },
  },
)

function ToggleGroup({
  className,
  size,
  onKeyDown,
  onFocus,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleGroupVariants>) {
  // Roving focus moves focus in a timeout after the keydown, so the focus
  // handler learns from this flag that a roving key, not Tab or a click, moved it.
  const rovingKeyRef = useRef(false)
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn(toggleGroupVariants({ size }), className)}
      onKeyDown={(event) => {
        // Radix ignores a roving key with a modifier, so no focus move follows it.
        rovingKeyRef.current =
          ROVING_KEYS.has(event.key) &&
          !(event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)
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
        // A coarse pointer gets a readable 32 px segment and its 44 px target
        // invisibly (`touch-hit-area`), not a 44 px box around a 12 px label.
        'coarse:h-8 coarse:px-3 coarse:text-sm touch-hit-area',
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
