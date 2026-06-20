/**
 * FilterValueSelect — shared single-select control over a per-category
 * value vocabulary, consumed by BOTH filter surfaces:
 *   - search builder forms (`components/search/filter-forms/`)
 *   - backlink category forms (`components/backlink-filter/categories/`)
 *
 * Issue #1647 — the State/Status and Priority forms on each surface had
 * byte-for-byte-duplicated `<Select>` scaffolding that differed ONLY in
 * the option vocabulary, the aria-label, and (search-only) the focus
 * trigger ref. This component parametrizes exactly those points so each
 * surface keeps its OWN behavior:
 *
 *   - Search State    passes the shared `useStateFilterOptions()` vocab
 *   - Backlink Status passes the SAME `useStateFilterOptions()` vocab
 *   - Search Priority passes `usePriorityLevels()`  + `none`
 *   - Backlink Priority passes 1/2/3                (translated labels)
 *
 * State/Status are unified (issue #1647 follow-up): both source the one
 * canonical set from `components/filters/forms/stateVocabulary.ts`, so the
 * value set can't drift. Priority remains per-surface. This control is
 * vocabulary-agnostic — it just renders whatever `options` a caller
 * passes; `label` may differ from `value`, so options carry both.
 */

import type React from 'react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface FilterValueOption {
  /** The emitted value (e.g. `TODO`, `1`, `none`). */
  value: string
  /** The visible row label. Defaults to `value` when omitted. */
  label?: React.ReactNode
}

export interface FilterValueSelectProps {
  /** Per-surface vocabulary. Each caller passes its OWN set (not unified). */
  options: readonly FilterValueOption[]
  value: string
  onValueChange: (value: string) => void
  /** Accessible label for the trigger. */
  ariaLabel: string
  /**
   * Optional ref to the trigger button. The search forms use this to move
   * focus into the sub-form on open; the backlink forms omit it.
   */
  triggerRef?: React.Ref<HTMLButtonElement>
  /** Optional extra classes for the trigger (backlink uses compact sizing). */
  triggerClassName?: string
}

export function FilterValueSelect({
  options,
  value,
  onValueChange,
  ariaLabel,
  triggerRef,
  triggerClassName,
}: FilterValueSelectProps): React.ReactElement {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger ref={triggerRef} size="sm" className={triggerClassName} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label ?? opt.value}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
