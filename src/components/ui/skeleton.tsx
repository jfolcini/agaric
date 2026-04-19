import type * as React from 'react'

import { cn } from '@/lib/utils'

const Skeleton = ({ ref, className, ...props }: React.ComponentProps<'div'>) => {
  return (
    <div
      ref={ref}
      data-slot="skeleton"
      className={cn('motion-safe:animate-pulse rounded-md bg-accent', className)}
      {...props}
    />
  )
}
Skeleton.displayName = 'Skeleton'

export { Skeleton }
