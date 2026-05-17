/**
 * PEND-54 — Filter chip row.
 *
 * Renders one chip per `FilterToken` in the parsed AST. The chip
 * label mirrors the canonical token source (`tag:#name`, `path:…`,
 * `not-path:…`); invalid tokens get a red-styled chip with the
 * tooltip carrying the typed error.
 *
 * Clicking the `×` removes that token from the query string via the
 * supplied `onRemove(index)` callback. The parent owns the query
 * string; this component is a pure projection.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { FilterPill } from '@/components/ui/filter-pill'
import type { FilterToken } from '@/lib/search-query'
import { tokenKey, tokenSource } from '@/lib/search-query'
import { cn } from '@/lib/utils'

export interface FilterChipRowProps {
  filters: FilterToken[]
  onRemove: (index: number) => void
  onClearAll: () => void
  /** Optional trailing slot (e.g. `+ Filter ▾` button). */
  trailing?: React.ReactNode
}

function labelFor(t: FilterToken): string {
  return tokenSource(t)
}

export function FilterChipRow({
  filters,
  onRemove,
  onClearAll,
  trailing,
}: FilterChipRowProps): React.ReactElement | null {
  const { t } = useTranslation()
  const hasFilters = filters.length > 0
  if (!hasFilters && !trailing) return null

  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset is for forms, not filter chip groups
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        hasFilters && 'rounded-lg border border-primary/30 bg-primary/5 p-2',
      )}
      data-testid="filter-chip-bar"
      role="group"
      aria-label={t('search.filtersActive')}
    >
      {filters.map((token, index) => {
        const label = labelFor(token)
        const isInvalid = token.kind === 'invalid'
        // Invalid chip styling: red border + aria-invalid + tooltip
        // carrying the typed error. Matches PEND-50's chip pattern.
        const invalidClass = isInvalid
          ? 'border-destructive/60 bg-destructive/10 text-destructive aria-invalid:border-destructive'
          : undefined
        const tooltip = token.kind === 'invalid' ? token.error : undefined
        return (
          <FilterPill
            key={tokenKey(token)}
            label={label}
            removeAriaLabel={t('search.removeFilter', { token: label })}
            onRemove={() => onRemove(index)}
            groupAriaLabel={
              isInvalid ? `${t('search.invalidFilter')}: ${label}` : `Filter: ${label}`
            }
            {...(invalidClass ? { className: invalidClass } : {})}
            {...(tooltip ? { title: tooltip } : {})}
          />
        )
      })}
      {trailing}
      {hasFilters && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs text-muted-foreground hover:text-foreground underline ml-1 rounded-sm focus-ring-visible"
        >
          {t('search.clearAll')}
        </button>
      )}
    </div>
  )
}
