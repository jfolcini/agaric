/**
 * ChevronToggle --- reusable expand/collapse chevron icon.
 *
 * Normalises the two chevron patterns used across the codebase (rotation
 * pattern and conditional icon swap) into a single animated rotation.
 * Optionally shows a loading spinner in place of the chevron, or — via
 * `solidWhenCollapsed` — swaps the collapsed glyph for a solid caret so the
 * state is legible without perceiving the rotation.
 */

import { cva, type VariantProps } from 'class-variance-authority'
// `Play` is lucide's centred right-pointing triangle — the classic outliner
// "collapsed" caret once filled. Aliased so call sites read as geometry, not
// as media playback.
import { ChevronRight, Play as SolidCaret } from 'lucide-react'
import type React from 'react'

import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'

const chevronToggleVariants = cva('shrink-0 transition-transform', {
  variants: {
    size: {
      sm: 'h-3 w-3',
      md: 'h-3.5 w-3.5',
      lg: 'h-4 w-4',
    },
  },
  defaultVariants: {
    size: 'sm',
  },
})

export interface ChevronToggleProps
  // `size` is the CVA dimension variant (sm/md/lg → Tailwind h-/w- classes), not
  // lucide's numeric icon `size`; omit the icon's `size`/`ref` so the variant wins.
  extends
    Omit<React.ComponentProps<typeof ChevronRight>, 'ref' | 'size'>,
    VariantProps<typeof chevronToggleVariants> {
  /** Whether the target content is expanded. Controls the 90-degree rotation. */
  isExpanded: boolean
  /** Show a spinning loader instead of the chevron (e.g. while fetching). */
  loading?: boolean
  /**
   * Render the COLLAPSED state as a solid (filled) caret instead of the
   * outline chevron, so collapsed-vs-expanded is carried by glyph shape and
   * fill — not by the 90-degree rotation alone. Opt-in: only surfaces where
   * the rotation is the sole state cue need it (see `BlockCollapseControl`).
   * No effect while `isExpanded` (the expanded glyph is always the outline
   * chevron) or while `loading`.
   */
  solidWhenCollapsed?: boolean | undefined
  /** Additional class names merged via `cn()`. */
  className?: string
}

export function ChevronToggle({
  isExpanded,
  loading = false,
  solidWhenCollapsed = false,
  size = 'sm',
  className,
  ...rest
}: ChevronToggleProps) {
  if (loading) {
    return (
      <Spinner
        data-slot="chevron-toggle"
        {...rest}
        className={cn(chevronToggleVariants({ size }), className)}
      />
    )
  }

  if (solidWhenCollapsed && !isExpanded) {
    return (
      <SolidCaret
        data-slot="chevron-toggle"
        data-solid="true"
        {...rest}
        // `fill-current` turns lucide's outline triangle into a solid wedge;
        // the 0.8 scale trims it back to the optical weight of the hairline
        // chevron it replaces, so the two states read as one control.
        className={cn(chevronToggleVariants({ size }), 'fill-current scale-[0.8]', className)}
      />
    )
  }

  return (
    <ChevronRight
      data-slot="chevron-toggle"
      {...rest}
      className={cn(chevronToggleVariants({ size }), isExpanded && 'rotate-90', className)}
    />
  )
}
