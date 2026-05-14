/**
 * MetricCard — shared "rounded card with big number + label" tile.
 *
 * Replaces the recurring inline shape
 * `<div className="rounded-lg border bg-muted/30 p-4 text-center">` that
 * appeared 5+ times in `StatusPanel.tsx` for sync / conflict / queue /
 * journal / peer counters (see plan
 * `pending/design-system-maintainability-2026-05-09.md` § 2d).
 *
 * Semantics:
 *  - The component renders as a `<div>` (default) but accepts an
 *    `as="dd-group"` mode that emits a `<div>` carrying `<dd>` value
 *    and label children, so callers can mount it inside a `<dl>` and
 *    keep description-list semantics.
 *  - `labelSlot` lets callers swap the default label for a richer node
 *    (e.g. a tooltip-wrapped `<dt>`).
 *  - `tone` colourises the border + value: `'warning'` and `'success'`
 *    map to status tokens.
 */

import type { LucideIcon } from 'lucide-react'
import type * as React from 'react'

import { cn } from '@/lib/utils'

export type MetricCardTone = 'default' | 'warning' | 'success'

const toneClasses: Record<MetricCardTone, string> = {
  default: '',
  warning: 'border-status-pending text-status-pending-foreground',
  success: 'border-status-done text-status-done-foreground',
}

export interface MetricCardProps {
  /** Plain-text label, ignored if `labelSlot` is provided. */
  label?: string
  /** Numeric / string / pre-formatted node rendered as the headline. */
  value: React.ReactNode
  /** Optional icon shown above the value. */
  icon?: LucideIcon
  /** Visual variant; defaults to `default`. */
  tone?: MetricCardTone
  /**
   * Replace the default `<dt>`-styled label node entirely. Used by
   * `StatusPanel` so the existing tooltip-bound `MetricLabel` keeps
   * working without re-implementing the tooltip wiring here.
   */
  labelSlot?: React.ReactNode
  /**
   * Optional sub-line shown below the label (e.g. "Peak: 12").
   */
  footer?: React.ReactNode
  /** Forwarded to the wrapper `<div>`. */
  className?: string
  /** Forwarded to the wrapper `<div>`. */
  ref?: React.Ref<HTMLDivElement>
  /**
   * Render mode: `'div'` (default) emits plain `<div>` children; the
   * `'dl-item'` mode emits `<dd>`/`<dt>` children for inclusion inside
   * a parent `<dl>`. Both modes still wrap in a `<div>`.
   */
  as?: 'div' | 'dl-item'
}

const MetricCard = ({
  ref,
  label,
  value,
  icon: Icon,
  tone = 'default',
  labelSlot,
  footer,
  className,
  as = 'dl-item',
}: MetricCardProps) => {
  const ValueTag = as === 'dl-item' ? 'dd' : 'div'
  const LabelTag = as === 'dl-item' ? 'dt' : 'div'
  const FooterTag = as === 'dl-item' ? 'dd' : 'div'
  return (
    <div
      ref={ref}
      data-slot="metric-card"
      className={cn('rounded-lg border bg-muted/30 p-4 text-center', toneClasses[tone], className)}
    >
      {Icon ? (
        <Icon aria-hidden="true" className="mx-auto mb-1 h-4 w-4 text-muted-foreground" />
      ) : null}
      <ValueTag className="text-2xl font-bold">{value}</ValueTag>
      {labelSlot ? (
        labelSlot
      ) : label ? (
        <LabelTag className="text-sm text-muted-foreground">{label}</LabelTag>
      ) : null}
      {footer ? (
        <FooterTag className="text-xs text-muted-foreground mt-1">{footer}</FooterTag>
      ) : null}
    </div>
  )
}
MetricCard.displayName = 'MetricCard'

export { MetricCard }
