/**
 * Include/exclude segmented toggle shared by the
 * structural filter builder forms (state / priority / prop).
 *
 * A two-segment `ToggleGroup` (a `radiogroup`), so the include vs. exclude
 * choice is announced and keyboard-operable. The caller owns the `negate`
 * boolean; this is a controlled component.
 */

import type React from 'react'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const INCLUDE = 'include'
const EXCLUDE = 'exclude'

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
    <ToggleGroup
      type="single"
      aria-label={label}
      value={negate ? EXCLUDE : INCLUDE}
      onValueChange={(next) => {
        // Pressing the checked segment again reports ''.
        if (next) onChange(next === EXCLUDE)
      }}
    >
      <ToggleGroupItem value={INCLUDE}>{includeLabel}</ToggleGroupItem>
      <ToggleGroupItem value={EXCLUDE}>{excludeLabel}</ToggleGroupItem>
    </ToggleGroup>
  )
}
