/**
 * SectionGroupHeader — sub-section label used inside agenda-like grouped
 * lists (DuePanel and its Overdue / Scheduled earlier / Upcoming sections,
 * DonePanel, AgendaResults…).
 *
 * The app-wide section-label typography (`text-xs font-medium
 * text-muted-foreground`, sentence case, no letter-spacing). No fill: the
 * rows under a header tint on hover and on the keyboard cursor, and a filled
 * header sitting directly on a tinted row reads as two notched boxes.
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
        'px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground [@media(pointer:coarse)]:text-sm',
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
