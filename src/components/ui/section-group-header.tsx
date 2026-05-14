/**
 * SectionGroupHeader — pill-shaped sub-section header used inside
 * agenda-like grouped lists (DuePanel, DonePanel, AgendaResults…).
 *
 * Rationale for adding alongside `SectionTitle` rather than extending it
 * (see plan `pending/design-system-maintainability-2026-05-09.md` § 2d):
 *
 *  - `SectionTitle` is an `<h4>` heading-style component with
 *    `text-xs font-semibold mb-1.5 flex items-center gap-1` and no
 *    background. It carries semantic heading weight (`color` prop maps
 *    to status tokens, label + numeric count layout).
 *  - The sites consolidated here use a chip-like
 *    `px-3 py-1 ... bg-muted/50 rounded` shape with `uppercase` +
 *    `tracking-wide` typography. They are *visual* sub-section
 *    breakers, not document headings — different role, different
 *    spacing, different background.
 *  - Folding both into one primitive with a `density`/`variant` flag
 *    would create a CVA matrix where most variant combinations are
 *    illegal (e.g. chip background only makes sense at the larger
 *    density). The cleaner path is two siblings with the same naming
 *    convention.
 *
 * Renders as `<div>` by default; pass `asChild` (Radix Slot) to render
 * as a heading-level element where semantically appropriate.
 */

import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

interface SectionGroupHeaderProps extends React.ComponentProps<'div'> {
  /** Render the children inside the consumer's element (e.g. `<h3>`). */
  asChild?: boolean
}

const SectionGroupHeader = ({
  ref,
  className,
  asChild = false,
  children,
  ...props
}: SectionGroupHeaderProps) => {
  const Comp = asChild ? Slot.Root : 'div'
  return (
    <Comp
      ref={ref}
      data-slot="section-group-header"
      className={cn(
        'px-3 py-1 text-xs font-semibold uppercase text-muted-foreground tracking-wide bg-muted/50 rounded [@media(pointer:coarse)]:text-sm',
        className,
      )}
      {...props}
    >
      {children}
    </Comp>
  )
}
SectionGroupHeader.displayName = 'SectionGroupHeader'

export { SectionGroupHeader }
