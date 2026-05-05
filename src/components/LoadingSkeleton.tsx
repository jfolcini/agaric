/**
 * LoadingSkeleton -- reusable skeleton loading placeholder.
 *
 * Renders N skeleton rows inside a `space-y-2` wrapper.
 * Used across list views (PageBrowser, TagList, ConflictList, etc.)
 * to show a consistent loading state.
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
}

export function LoadingSkeleton({
  count = 3,
  variant = 'text',
  height,
  className,
  ...rest
}: LoadingSkeletonProps) {
  const heightClass = height ?? VARIANT_HEIGHT[variant]
  return (
    <div className={cn('space-y-2', className)} {...rest}>
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list of identical skeletons
        <Skeleton key={i} className={cn(heightClass, 'w-full rounded-lg')} />
      ))}
    </div>
  )
}
