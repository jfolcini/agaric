import type * as React from 'react'

import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/**
 * MenuSheet — a phone's form of a long action menu: a bottom sheet holding
 * the menu's rows, in thumb reach, instead of a dropdown that covers most of
 * the screen (#5931). The caller renders its own `role="menu"` list as the
 * children, so the desktop dropdown and this sheet share every row.
 *
 * No close button: the overlay, Escape and the back gesture dismiss it, as
 * they dismiss the dropdown. The title is for screen readers; the rows are
 * the visible content.
 */
interface MenuSheetProps extends Omit<React.ComponentProps<typeof SheetContent>, 'title'> {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accessible name of the sheet; matches the menu's own label. */
  title: string
  /** A `SheetTrigger`, when the sheet has one. */
  trigger?: React.ReactNode
}

export function MenuSheet({
  open,
  onOpenChange,
  title,
  trigger,
  className,
  children,
  ...contentProps
}: MenuSheetProps): React.ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger}
      <SheetContent
        side="bottom"
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn('gap-0 px-2 pt-2 pb-[calc(0.5rem+var(--safe-area-bottom))]', className)}
        {...contentProps}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="[&>div]:!block">
          {children}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
