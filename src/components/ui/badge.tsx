import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'

import { priorityColor } from '@/lib/priority-color'
import { cn } from '@/lib/utils'

/**
 * Unified Badge primitive (UX item 4 / Maintain 2c).
 *
 * Axes:
 *  - `tone`:  visual intent (`default | secondary | destructive | outline |
 *             ghost | link | priority | status`). The legacy `variant` prop
 *             is kept as a deprecated alias so existing callers keep working.
 *  - `size`:  `xs | sm | default` — `default` matches the original `text-xs`
 *             pill, `sm` is the dense `PriorityBadge` md size, `xs` is the
 *             very-dense priority-badge sm size.
 *  - `shape`: `pill` (rounded-full, the original Badge shape) or `rounded`
 *             (square-corner rounded, matching the old `StatusBadge` /
 *             `PriorityBadge` chrome).
 *
 * Tone-specific colour data passes through the dedicated props:
 *  - `tone="priority"` → reads `priorityLevel` and delegates to
 *    `priorityColor()` (UX-201b: index-based, theme-aware).
 *  - `tone="status"`   → reads `statusState` and applies the matching
 *    `bg-status-*` / `bg-alert-*` token pair.
 *
 * `StatusBadge` and `PriorityBadge` are collapsed into this primitive; see
 * `pending/design-system-maintainability-2026-05-09.md` §2c.
 */

const BASE =
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-visible border border-transparent font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-ring-visible aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3'

const badgeVariants = cva(BASE, {
  variants: {
    tone: {
      default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
      secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
      destructive:
        'bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90',
      outline:
        'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
      ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
      link: 'text-primary underline-offset-4 [a&]:hover:underline',
      // `priority` and `status` deliberately omit colour classes — the
      // wrapping component appends them via `priorityColor()` or the
      // status-state map below so the tone+state combinations stay in
      // sync with the design tokens.
      priority: 'font-bold leading-none',
      status: 'font-bold leading-none',
    },
    size: {
      // `xs` / `sm` mirror the dense `PriorityBadge` sm/md cells
      // (fixed height + min-width so single-glyph `P1` is a centred square).
      xs: 'h-3.5 min-w-3.5 px-0.5 py-0 text-xs',
      sm: 'h-4 min-w-4 px-1 py-0 text-xs',
      // `compact` matches the legacy `StatusBadge` chrome (no fixed
      // height, `px-1 py-0.5` so the badge hugs the text like a label).
      compact: 'px-1 py-0.5 text-xs',
      // `default` is the original `Badge` pill.
      default: 'px-2 py-0.5 text-xs',
      // `lg` mirrors the priority-badge `lg` variant (header chip).
      lg: 'h-6 min-w-6 px-2 py-0 text-sm',
    },
    shape: {
      pill: 'rounded-full',
      rounded: 'rounded',
    },
  },
  defaultVariants: { tone: 'default', size: 'default', shape: 'pill' },
})

/**
 * StatusBadge state → background/foreground token pair. Kept in this
 * primitive so `tone="status"` callers only pass `statusState`.
 */
const STATUS_STATE_CLASSES = {
  DONE: 'bg-status-done text-status-done-foreground',
  DOING: 'bg-status-active text-status-active-foreground',
  TODO: 'bg-status-pending text-status-pending-foreground',
  default: 'bg-status-pending text-status-pending-foreground',
  overdue: 'bg-alert-warning text-alert-warning-foreground',
} as const

export type BadgeStatusState = keyof typeof STATUS_STATE_CLASSES

type BadgeOwnProps = VariantProps<typeof badgeVariants> & {
  /** Priority key when `tone='priority'` (e.g. `'1'`, `'A'`). */
  priorityLevel?: string | null
  /** Status state when `tone='status'`. */
  statusState?: BadgeStatusState
  asChild?: boolean
  className?: string
}

export type BadgeProps = Omit<React.ComponentProps<'span'>, 'children'> &
  BadgeOwnProps & { children?: React.ReactNode }

const Badge = ({
  ref,
  className,
  tone,
  size,
  shape,
  priorityLevel,
  statusState,
  asChild = false,
  children,
  ...props
}: BadgeProps) => {
  const Comp = asChild ? Slot.Root : 'span'
  const resolvedTone = tone ?? 'default'

  // Append tone-specific colour classes that the CVA recipe deliberately
  // omits (so `priority`/`status` callers don't have to wire up colours).
  const toneColor =
    resolvedTone === 'priority'
      ? priorityColor(priorityLevel ?? null)
      : resolvedTone === 'status'
        ? STATUS_STATE_CLASSES[statusState ?? 'default']
        : ''

  return (
    <Comp
      ref={ref}
      data-slot="badge"
      data-variant={resolvedTone}
      className={cn(badgeVariants({ tone: resolvedTone, size, shape }), toneColor, className)}
      {...props}
    >
      {children}
    </Comp>
  )
}
Badge.displayName = 'Badge'

export { Badge, badgeVariants }
