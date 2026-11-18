/**
 * InfoPopover — an explanation the user needs, behind a trigger they can tap.
 *
 * A `Tooltip` opens on hover and focus only, so a phone user never sees it;
 * it is for a supplementary label (an icon's name, a shortcut) that the
 * control's accessible name already carries. Anything the user needs to read
 * goes here instead: it opens on tap, click, Enter and Space, and closes on
 * Escape or a press outside (#6895).
 *
 * Two triggers:
 * - `label`: the label text itself, with a dotted underline (App health's
 *   counters).
 * - `icon`: an ⓘ button beside a label or control, named by `ariaLabel`. It is
 *   the cue everywhere else, including beside a disabled control, where it
 *   stays enabled so the reason can still be opened.
 *
 * Both get a 44 px hit area under a coarse pointer. The popover is named by its
 * trigger, so a screen reader hears what it explains. A press on the trigger or
 * inside the popover stays out of a selectable row around it (History): React
 * bubbles a portal's events to the trigger's ancestors.
 */

import { cva } from 'class-variance-authority'
import { Info } from 'lucide-react'
import { useId } from 'react'
import type * as React from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const triggerVariants = cva('bg-transparent p-0 touch-hit-area focus-ring-visible', {
  variants: {
    variant: {
      label: 'cursor-help border-b border-dotted border-current font-inherit text-inherit',
      icon: 'inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground hover:text-foreground',
    },
  },
})

interface InfoPopoverBaseProps {
  /** The explanation. */
  content: React.ReactNode
  /** Forwarded to the trigger button. */
  className?: string
}

export type InfoPopoverProps = InfoPopoverBaseProps &
  (
    | {
        variant?: 'label'
        /** The visible label; it opens the explanation. */
        children: React.ReactNode
      }
    | {
        variant: 'icon'
        /** What the ⓘ explains, through `t()`. */
        ariaLabel: string
      }
  )

function InfoPopover(props: InfoPopoverProps): React.ReactElement {
  const triggerId = useId()
  const variant = props.variant ?? 'label'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          id={triggerId}
          type="button"
          data-slot="info-popover-trigger"
          className={cn(triggerVariants({ variant }), props.className)}
          {...(props.variant === 'icon' ? { 'aria-label': props.ariaLabel } : {})}
          onClick={(e) => e.stopPropagation()}
        >
          {props.variant === 'icon' ? (
            <Info className="size-4" aria-hidden="true" />
          ) : (
            props.children
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-slot="info-popover-content"
        aria-labelledby={triggerId}
        className="w-auto max-w-xs p-3 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        {props.content}
      </PopoverContent>
    </Popover>
  )
}
InfoPopover.displayName = 'InfoPopover'

export { InfoPopover }
