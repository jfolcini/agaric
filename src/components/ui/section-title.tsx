import type * as React from 'react'

import { cn } from '@/lib/utils'

interface SectionTitleProps {
  color: string
  label: string
  count: number
  className?: string
  ref?: React.Ref<HTMLHeadingElement>
}

const SectionTitle = ({ ref, color, label, count, className }: SectionTitleProps) => {
  return (
    <h4
      ref={ref}
      data-slot="section-title"
      className={cn('text-xs font-semibold mb-1.5 flex items-center gap-1', color, className)}
    >
      <span>{label}</span>
      <span className="text-muted-foreground font-normal">({count})</span>
    </h4>
  )
}
SectionTitle.displayName = 'SectionTitle'

export { SectionTitle }
