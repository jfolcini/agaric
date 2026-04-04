/**
 * LoadingSkeleton -- reusable skeleton loading placeholder.
 *
 * Renders N skeleton rows inside a `space-y-2` wrapper.
 * Used across list views (PageBrowser, TagList, ConflictList, etc.)
 * to show a consistent loading state.
 */

import { cn } from '@/lib/utils'
import { Skeleton } from './ui/skeleton'

interface LoadingSkeletonProps extends React.ComponentProps<'div'> {
  /** Number of skeleton rows to render. */
  count?: number
  /** Tailwind height class for each skeleton row (e.g. "h-4", "h-8"). */
  height?: string
}

export function LoadingSkeleton({
  count = 3,
  height = 'h-4',
  className,
  ...rest
}: LoadingSkeletonProps) {
  return (
    <div className={cn('space-y-2', className)} {...rest}>
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list of identical skeletons
        <Skeleton key={i} className={`${height} w-full rounded-lg`} />
      ))}
    </div>
  )
}
