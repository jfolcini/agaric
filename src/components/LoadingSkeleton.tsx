/**
 * LoadingSkeleton -- reusable skeleton loading placeholder.
 *
 * Renders N skeleton rows inside a `space-y-2` wrapper.
 * Used across list views (PageBrowser, TagList, etc.)
 * to show a consistent loading state.
 *
 * Per UX.md, loading containers should expose `role="status"` and
 * `aria-busy="true"` so assistive tech announces the loading state.
 * When the `loading` prop is set, the primitive wraps its output in an
 * a11y-compliant `<div role="status" aria-busy="true" aria-label="…">`
 * so call sites no longer have to repeat that scaffolding by hand.
 */

import { cn } from '@/lib/utils'
import { Skeleton } from './ui/skeleton'

/**
 * PEND-23 L4 — Variant maps to a sensible default height per use-case so
 * call sites don't need to remember which `h-*` matches a list-row vs a
 * heading vs a button. Explicit `height` still wins as an escape hatch.
 */
export type LoadingSkeletonVariant = 'text' | 'heading' | 'button' | 'list-row'

const VARIANT_HEIGHT: Record<LoadingSkeletonVariant, string> = {
  text: 'h-4',
  heading: 'h-6',
  button: 'h-9',
  'list-row': 'h-11',
}

interface LoadingSkeletonProps extends React.ComponentProps<'div'> {
  /** Number of skeleton rows to render. */
  count?: number
  /** Visual variant — picks a sensible default height. Defaults to `'text'`. */
  variant?: LoadingSkeletonVariant
  /** Tailwind height class for each skeleton row (e.g. "h-4", "h-8"). Overrides `variant`. */
  height?: string
  /**
   * When `true`, wrap the rendered rows in an a11y-compliant container
   * (`<div role="status" aria-busy="true" aria-label={ariaLabel}>`) so
   * screen readers announce the loading state. Defaults to `true` — set
   * it to `false` only when the caller is already providing its own
   * busy wrapper and just needs the bare skeleton rows.
   *
   * Note: callers that wrap `<LoadingSkeleton>` in their own
   * `<div aria-busy="true">` continue to work because the new wrapper
   * is purely additive (nested `aria-busy` regions are valid).
   */
  loading?: boolean
  /**
   * Label announced by assistive tech when `loading` is `true`. Defaults
   * to `"Loading"`. Pass a more specific label (e.g. `"Loading pages"`)
   * when the caller knows the domain.
   */
  ariaLabel?: string
}

export function LoadingSkeleton({
  count = 3,
  variant = 'text',
  height,
  className,
  loading = true,
  ariaLabel,
  ...rest
}: LoadingSkeletonProps) {
  const heightClass = height ?? VARIANT_HEIGHT[variant]
  const wrapperA11y = loading
    ? { 'aria-busy': true as const, role: 'status', 'aria-label': ariaLabel ?? 'Loading' }
    : {}
  return (
    <div className={cn('space-y-2', className)} {...wrapperA11y} {...rest}>
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list of identical skeletons
        <Skeleton key={i} className={cn(heightClass, 'w-full rounded-lg')} />
      ))}
    </div>
  )
}
