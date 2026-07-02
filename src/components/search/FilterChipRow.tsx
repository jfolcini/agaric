/**
 * Filter chip row.
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
import { useEffect, useState } from 'react'
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

/**
 * Quiet period before the shared `role="alert"` region reflects the current
 * invalid-token set. The chip row is a projection of the LIVE query AST
 * (SearchPanel parses on every keystroke), so a token is transiently
 * `invalid` while the user is mid-token (`tag:` before the value, `due:2`
 * before a full date). Announcing each keystroke would spam assertive
 * live-region output; instead the alert only surfaces once the invalid state
 * has settled. 300ms matches SearchPanel's canonical input debounce (the
 * observed settle window already used for search execution on this surface).
 */
const INVALID_ALERT_SETTLE_MS = 300

export function FilterChipRow({
  filters,
  onRemove,
  onClearAll,
  trailing,
}: FilterChipRowProps): React.ReactElement | null {
  const { t } = useTranslation()
  const hasFilters = filters.length > 0
  // Invalid tokens surfaced in a single shared row-level `role="alert"` region
  // (see below). One inline alert per pill would fragment the flex-wrap chip
  // bar into competing live regions and add visual noise; a single summarizing
  // alert mirrors InPageFind's single regex-error region and fits the design.
  const invalidTokens = filters.filter((token) => token.kind === 'invalid')
  // The alert content only updates after the invalid set has been stable for
  // INVALID_ALERT_SETTLE_MS (see the constant's doc comment): transient
  // mid-typing invalid states (`tag:` → `tag:#u`) never reach the live
  // region. Clearing is immediate — once every token is valid the error line
  // must not linger.
  const errorMessage = invalidTokens
    .map((token) =>
      t('search.invalidFilterError', {
        label: labelFor(token),
        error: token.kind === 'invalid' ? token.error : '',
      }),
    )
    .join('; ')
  const [settledErrorMessage, setSettledErrorMessage] = useState('')
  useEffect(() => {
    if (errorMessage === '') {
      setSettledErrorMessage('')
      return undefined
    }
    const timer = setTimeout(() => {
      setSettledErrorMessage(errorMessage)
    }, INVALID_ALERT_SETTLE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [errorMessage])
  if (!hasFilters && !trailing) return null

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        hasFilters && 'rounded-lg border border-primary/30 bg-primary/5 p-2',
      )}
      data-testid="filter-chip-bar"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="group" + aria-label on a flex-wrap chip container; <fieldset>/<details>/<hgroup> carry unwanted default rendering/semantics and would break the inline chip-bar layout
      role="group"
      aria-label={t('search.filtersActive')}
    >
      {filters.map((token, index) => {
        const label = labelFor(token)
        const isInvalid = token.kind === 'invalid'
        const error = token.kind === 'invalid' ? token.error : undefined
        // Invalid chip styling: red border + aria-invalid + tooltip
        // Carrying the typed error. Matches chip pattern.
        const invalidClass = isInvalid
          ? 'border-destructive/60 bg-destructive/10 text-destructive aria-invalid:border-destructive'
          : undefined
        return (
          <FilterPill
            key={tokenKey(token)}
            label={label}
            removeAriaLabel={t('search.removeFilter', { token: label })}
            onRemove={() => onRemove(index)}
            // Thread aria-invalid to the Badge so its `aria-invalid:border-destructive`
            // variant goes live (was previously dead — only the hover title
            // carried any error signal).
            {...(isInvalid ? { 'aria-invalid': true } : {})}
            groupAriaLabel={
              isInvalid
                ? // Accessible name carries the parser error, not just "invalid".
                  t('search.invalidFilterWithError', { label, error: error ?? '' })
                : t('search.filterGroupLabel', { value: label })
            }
            {...(invalidClass ? { className: invalidClass } : {})}
            {...(error ? { title: error } : {})}
          />
        )
      })}
      {trailing}
      {/* Shared visible + programmatic error surface for invalid chips.
          `role="alert"` announces newly-invalid filters (matches InPageFind's
          regex-error region). `basis-full` drops it onto its own line within
          the flex-wrap bar so it never squeezes the chips. */}
      {settledErrorMessage !== '' && (
        <p
          role="alert"
          data-testid="filter-chip-errors"
          className="basis-full w-full m-0 text-xs text-destructive"
        >
          {settledErrorMessage}
        </p>
      )}
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
