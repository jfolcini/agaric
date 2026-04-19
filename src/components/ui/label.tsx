/**
 * Label — shared form label with size and color variants.
 *
 * Standardizes the 8+ raw `<label>` elements scattered across the app
 * into a single component with consistent typography and spacing.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const labelVariants = cva('font-medium', {
  variants: {
    size: {
      sm: 'text-sm',
      xs: 'text-xs',
    },
    muted: {
      true: 'text-muted-foreground',
      false: '',
    },
  },
  defaultVariants: {
    size: 'sm',
    muted: true,
  },
})

type LabelProps = React.ComponentProps<'label'> & VariantProps<typeof labelVariants>

const Label = ({ ref, className, size, muted, ...props }: LabelProps) => {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is forwarded via spread props
    <label
      ref={ref}
      data-slot="label"
      className={cn(labelVariants({ size, muted, className }))}
      {...props}
    />
  )
}
Label.displayName = 'Label'

export { Label, labelVariants }
