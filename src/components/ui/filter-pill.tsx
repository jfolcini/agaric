/**
 * FilterPill -- generic removable filter badge with accessible touch targets.
 *
 * Extracted from FilterPillRow (#) to eliminate the duplicated
 * Badge + X button pattern. Provides keyboard handling (Delete/Backspace),
 * ARIA labelling, and coarse-pointer touch targets out of the box.
 */

import { X } from 'lucide-react'
import type React from 'react'

import { Badge } from '@/components/ui/badge'
import { TruncatedText } from '@/components/ui/truncated-text'
import { cn } from '@/lib/utils'

// No `title`: a native title never shows on a tap (#6895). An explanation goes in an ⓘ beside
// the pill; a long label is already a `TruncatedText`.
export interface FilterPillProps extends Omit<
  React.ComponentProps<typeof Badge>,
  'children' | 'title'
> {
  /** The label to display in the pill. */
  label: string
  /** Called when the remove button is clicked or Delete/Backspace is pressed. */
  onRemove: () => void
  /** Accessible label for the remove button (e.g., "Remove filter status = TODO"). */
  removeAriaLabel: string
  /** Optional className for the Badge wrapper. */
  className?: string
  /** Optional aria-label for the Badge group wrapper. Defaults to `label`. */
  groupAriaLabel?: string
}

export function FilterPill({
  label,
  onRemove,
  removeAriaLabel,
  className,
  groupAriaLabel,
  ...rest
}: FilterPillProps): React.ReactElement {
  // E6 — a long tag/path/property value must not stretch the pill to an
  // unbounded width (which wraps the chip to its own line and can push
  // Add-filter / Clear-all off-screen on narrow viewports). Cap the pill and
  // truncate the label.
  return (
    <Badge
      data-slot="filter-pill"
      tone="secondary"
      {...rest}
      className={cn(
        'filter-pill rounded-md min-w-0 max-w-[16rem] shrink-0 gap-1 text-xs',
        className,
      )}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role is forwarded to a <Badge> wrapper grouping a label + remove button; <fieldset>/<optgroup> etc. would break the inline pill layout and carry form/list semantics
      role="group"
      aria-label={groupAriaLabel ?? label}
    >
      <TruncatedText>{label}</TruncatedText>
      <button
        type="button"
        // `-mr-0.5` cancels its own padding: the glyph sits as far from the
        // pill's edge as the label does, and the 44 px target is invisible.
        className="-mr-0.5 inline-flex shrink-0 items-center justify-center rounded-sm p-0.5 hover:bg-muted active:bg-muted active:scale-95 focus-ring-visible touch-hit-area"
        onClick={onRemove}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            onRemove()
          }
        }}
        aria-label={removeAriaLabel}
      >
        <X className="h-3 w-3 [@media(pointer:coarse)]:size-3.5" />
      </button>
    </Badge>
  )
}
