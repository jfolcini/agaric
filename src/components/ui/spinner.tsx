/**
 * Spinner — shared animated loading indicator.
 *
 * Thin wrapper around Loader2 that standardizes size variants and
 * always applies `animate-spin`. Four sizes map to the four variants
 * found across the codebase (h-3.5, h-4, h-5, h-6).
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const spinnerVariants = cva('animate-spin', {
  variants: {
    size: {
      sm: 'h-3.5 w-3.5',
      md: 'h-4 w-4',
      lg: 'h-5 w-5',
      xl: 'h-6 w-6',
    },
  },
  defaultVariants: {
    size: 'md',
  },
})

type SpinnerProps = Omit<React.ComponentProps<typeof Loader2>, 'ref'> &
  VariantProps<typeof spinnerVariants>

function Spinner({ size, className, ...props }: SpinnerProps) {
  return (
    <Loader2 data-slot="spinner" className={cn(spinnerVariants({ size, className }))} {...props} />
  )
}

export { Spinner, spinnerVariants }
