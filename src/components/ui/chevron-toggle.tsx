/**
 * ChevronToggle --- reusable expand/collapse chevron icon.
 *
 * Normalises the two chevron patterns used across the codebase (rotation
 * pattern and conditional icon swap) into a single animated rotation.
 * Optionally shows a loading spinner in place of the chevron.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { ChevronRight, Loader2 } from 'lucide-react'

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

export interface ChevronToggleProps extends VariantProps<typeof chevronToggleVariants> {
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
}: ChevronToggleProps) {
  if (loading) {
    return <Loader2 className={cn(chevronToggleVariants({ size }), 'animate-spin', className)} />
  }

  return (
    <ChevronRight
      className={cn(chevronToggleVariants({ size }), isExpanded && 'rotate-90', className)}
    />
  )
}
