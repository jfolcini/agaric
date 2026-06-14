/**
 * ChevronToggle --- reusable expand/collapse chevron icon.
 *
 * Normalises the two chevron patterns used across the codebase (rotation
 * pattern and conditional icon swap) into a single animated rotation.
 * Optionally shows a loading spinner in place of the chevron.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { ChevronRight } from 'lucide-react'
import type React from 'react'

import { cn } from '@/lib/utils'

import { Spinner } from './spinner'

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
  /** Additional class names merged via `cn()`. */
  className?: string
}

export function ChevronToggle({
  isExpanded,
  loading = false,
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

  return (
    <ChevronRight
      data-slot="chevron-toggle"
      {...rest}
      className={cn(chevronToggleVariants({ size }), isExpanded && 'rotate-90', className)}
    />
  )
}
