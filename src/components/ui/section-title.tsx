import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Semantic color tokens for section headings.
 *
 * The mapping uses the existing CSS custom-property tokens defined in
 * `src/index.css` (`--color-status-*` + `--color-destructive`). There is no
 * `--color-status-overdue` token in this codebase — overdue text fills
 * already use `text-destructive` (see `AlertSection.tsx`, the only caller
 * at the time of writing) so `'overdue'` maps to that here for parity.
 *
 * The `*-foreground` variants are the appropriate text fills paired with
 * their lighter `bg-status-*` companions (see `StatusBadge`, `agenda-sort`,
 * `DonePanel`, etc.).
 */
export type SectionTitleColor = 'done' | 'active' | 'pending' | 'overdue' | 'default'

const colorClassFor = (color: SectionTitleColor): string => {
  switch (color) {
    case 'done':
      return 'text-status-done-foreground'
    case 'active':
      return 'text-status-active-foreground'
    case 'pending':
      return 'text-status-pending-foreground'
    case 'overdue':
      return 'text-destructive'
    case 'default':
      return 'text-foreground'
  }
}

interface SectionTitleProps extends React.ComponentProps<'h4'> {
  color?: SectionTitleColor
  label: string
  count: number
  className?: string
}

const SectionTitle = ({
  ref,
  color = 'default',
  label,
  count,
  className,
  ...rest
}: SectionTitleProps) => {
  return (
    <h4
      ref={ref}
      data-slot="section-title"
      {...rest}
      className={cn(
        'text-xs font-semibold mb-1.5 flex items-center gap-1',
        colorClassFor(color),
        className,
      )}
    >
      <span>{label}</span>
      <span className="text-muted-foreground font-normal">({count})</span>
    </h4>
  )
}
SectionTitle.displayName = 'SectionTitle'

export { SectionTitle }
