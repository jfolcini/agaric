/**
 * FilterPill -- generic removable filter badge with accessible touch targets.
 *
 * Extracted from FilterPillRow (#M-27) to eliminate the duplicated
 * Badge + X button pattern. Provides keyboard handling (Delete/Backspace),
 * ARIA labelling, and coarse-pointer touch targets out of the box.
 */

import { X } from 'lucide-react'
import type React from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface FilterPillProps {
  /** The label to display in the pill. */
  label: string
  /** Called when the remove button is clicked or Delete/Backspace is pressed. */
  onRemove: () => void
  /** Accessible label for the remove button (e.g., "Remove filter status = TODO"). */
  removeAriaLabel: string
  /** Optional className for the Badge wrapper. */
  className?: string
  /** Optional tooltip text for the Badge. */
  title?: string
  /** Optional aria-label for the Badge group wrapper. Defaults to `label`. */
  groupAriaLabel?: string
}

export function FilterPill({
  label,
  onRemove,
  removeAriaLabel,
  className,
  title,
  groupAriaLabel,
}: FilterPillProps): React.ReactElement {
  return (
    <Badge
      variant="secondary"
      className={cn('filter-pill shrink-0 gap-1 text-xs', className)}
      role="group"
      aria-label={groupAriaLabel ?? label}
      title={title}
    >
      {label}
      <button
        type="button"
        className="ml-0.5 inline-flex items-center justify-center rounded-full p-1 hover:bg-muted active:bg-muted active:scale-95 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden [@media(pointer:coarse)]:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px] touch-target"
        onClick={onRemove}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            onRemove()
          }
        }}
        aria-label={removeAriaLabel}
      >
        <X className="h-3 w-3 [@media(pointer:coarse)]:size-5" />
      </button>
    </Badge>
  )
}
