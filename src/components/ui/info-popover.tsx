/**
 * InfoPopover — an explanation the user needs, behind a label they can tap.
 *
 * A `Tooltip` opens on hover and focus only, so a phone user never sees it;
 * it is for a supplementary label (an icon's name, a shortcut) that the
 * control's accessible name already carries. Anything the user needs to read
 * goes here instead: it opens on tap, click, Enter and Space, and closes on
 * Escape or a press outside (#6895).
 *
 * The trigger is the label text itself, marked with a dotted underline, and
 * gets a 44 px hit area under a coarse pointer. The popover is named by that
 * label, so a screen reader hears what it explains.
 */

import { useId } from 'react'
import type * as React from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface InfoPopoverProps {
  /** The visible label; it opens the explanation. */
  children: React.ReactNode
  /** The explanation. */
  content: React.ReactNode
  /** Forwarded to the trigger button. */
  className?: string
}

function InfoPopover({ children, content, className }: InfoPopoverProps): React.ReactElement {
  const triggerId = useId()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          id={triggerId}
          type="button"
          data-slot="info-popover-trigger"
          className={cn(
            'cursor-help border-b border-dotted border-current bg-transparent p-0 font-inherit text-inherit touch-hit-area focus-ring-visible',
            className,
          )}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-slot="info-popover-content"
        aria-labelledby={triggerId}
        className="w-auto max-w-xs p-3 text-sm"
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}
InfoPopover.displayName = 'InfoPopover'

export { InfoPopover }
