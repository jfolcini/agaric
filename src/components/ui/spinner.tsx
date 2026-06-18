/**
 * Spinner — shared animated loading indicator.
 *
 * Thin wrapper around Loader2 that standardizes size variants and
 * always applies `animate-spin`. Four sizes map to the four variants
 * found across the codebase (h-3.5, h-4, h-5, h-6).
 *
 * Accessibility (#1753): a bare spinning <svg> carries no semantics, so by
 * default the Spinner is `aria-hidden` — appropriate when a caller already
 * provides its own loading text/label (the common case). For a standalone
 * loading indicator, pass `label` to opt into an announced status: the SVG
 * gains `role="status"` + the label as its accessible name (so assistive
 * technology announces the loading state). The label defaults to the
 * translated `ui.loading` string and can be overridden per call. Callers may
 * still override `role`/`aria-label`/`aria-hidden` directly via props.
 */

import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'

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
  VariantProps<typeof spinnerVariants> & {
    ref?: React.Ref<SVGSVGElement>
    /**
     * Opt into an announced loading status. When provided (or `true`), the
     * spinner renders `role="status"` with this string as its accessible
     * name. `true` uses the default translated label (`ui.loading`).
     * Omit it for decorative spinners that sit next to existing text.
     */
    label?: string | boolean
  }

const Spinner = ({ ref, size, className, label, ...props }: SpinnerProps) => {
  const { t } = useTranslation()

  // Resolve the accessible label: `true` → default translated string,
  // a string → that string, anything falsy → decorative (no label).
  const accessibleLabel =
    label === true ? t('ui.loading') : typeof label === 'string' ? label : undefined

  // Announced mode emits role="status" + an accessible name; decorative mode
  // is hidden from the accessibility tree. Both remain overridable via props.
  const a11yProps = accessibleLabel
    ? { role: 'status' as const, 'aria-label': accessibleLabel }
    : { 'aria-hidden': true as const }

  return (
    <Loader2
      ref={ref}
      data-slot="spinner"
      className={cn(spinnerVariants({ size }), className)}
      {...a11yProps}
      {...props}
    />
  )
}
Spinner.displayName = 'Spinner'

export { Spinner, spinnerVariants }
