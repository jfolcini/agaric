/**
 * PEND-58g UX-A5 — include/exclude segmented toggle shared by the
 * structural filter builder forms (state / priority / prop).
 *
 * Rendered as a `role="radiogroup"` of two `role="radio"` buttons so the
 * include vs. exclude choice is announced and keyboard-operable. The
 * caller owns the `negate` boolean; this is a controlled component.
 */

import type React from 'react'

import { cn } from '@/lib/utils'

export interface IncludeExcludeToggleProps {
  /** `true` selects the exclude (`not-…`) variant. */
  negate: boolean
  onChange: (negate: boolean) => void
  /** Accessible group label, e.g. "Match mode". */
  label: string
  includeLabel: string
  excludeLabel: string
}

export function IncludeExcludeToggle({
  negate,
  onChange,
  label,
  includeLabel,
  excludeLabel,
}: IncludeExcludeToggleProps): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-md border border-input p-0.5 gap-0.5"
    >
      {(
        [
          { value: false, text: includeLabel },
          { value: true, text: excludeLabel },
        ] as const
      ).map(({ value, text }) => {
        const selected = negate === value
        return (
          <button
            key={String(value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(value)}
            className={cn(
              'rounded px-2 py-1 text-xs focus-ring-visible [@media(pointer:coarse)]:min-h-11',
              selected
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}
