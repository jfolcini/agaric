/**
 * PEND-58g UX-A5 — `prop:key=value` / `not-prop:key=value` builder form.
 *
 * Free-form key + value text inputs (the property vocabulary is
 * space-scoped and not enumerated here) plus an include/exclude toggle.
 * Emits a `prop` or `notProp` `FilterToken` and closes the popover.
 *
 * PEND-70 CR8 MAJOR-1 — round-trip validation. The token is serialised
 * verbatim as `prop:KEY=VALUE` (no quoting in the DSL), then re-tokenised
 * by splitting on whitespace and on the FIRST `=`. So a KEY containing
 * whitespace / `=` / `"`, or a VALUE containing whitespace / `"`, would
 * silently corrupt the executed search and the rendered chip. We reject
 * those at the form so the round-trip is always lossless. (A `=` inside the
 * VALUE is fine — the parser splits on the first `=` only.)
 */

import type React from 'react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { FilterToken } from '@/lib/search-query'
import { IncludeExcludeToggle } from './IncludeExcludeToggle'

export interface PropFilterFormProps {
  onAddFilter: (token: FilterToken) => void
  onBack: () => void
}

/** A property key is an identifier: no whitespace, `=`, or `"`. */
function isKeyValid(key: string): boolean {
  return !/[\s="]/.test(key)
}

/** A property value cannot contain whitespace or `"` (a `=` is allowed). */
function isValueValid(value: string): boolean {
  return !/[\s"]/.test(value)
}

export function PropFilterForm({ onAddFilter, onBack }: PropFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [negate, setNegate] = useState(false)

  const keyErrorId = useId()
  const valueErrorId = useId()

  const trimmedKey = key.trim()
  const trimmedValue = value.trim()

  const keyValid = isKeyValid(trimmedKey)
  const valueValid = isValueValid(trimmedValue)

  // Only surface an error once the field is non-empty (don't yell at an
  // empty form). `canSubmit` still requires non-empty AND valid.
  const showKeyError = trimmedKey !== '' && !keyValid
  const showValueError = trimmedValue !== '' && !valueValid

  const canSubmit = trimmedKey !== '' && trimmedValue !== '' && keyValid && valueValid

  function submit() {
    const k = key.trim()
    const v = value.trim()
    if (!k || !v) return
    if (!isKeyValid(k) || !isValueValid(v)) return
    const token: FilterToken = negate
      ? { kind: 'notProp', key: k, value: v, span: [0, 0] }
      : { kind: 'prop', key: k, value: v, span: [0, 0] }
    onAddFilter(token)
  }

  return (
    <form
      data-testid="prop-filter-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="text-sm font-medium">{t('search.filterCategory.prop')}</div>
      <div className="mt-2 flex flex-col gap-2">
        <IncludeExcludeToggle
          negate={negate}
          onChange={setNegate}
          label={t('search.filterHelper.matchMode')}
          includeLabel={t('search.filterHelper.include')}
          excludeLabel={t('search.filterHelper.exclude')}
        />
        <div className="flex flex-col gap-1">
          <Input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t('search.filterHelper.propKeyPlaceholder')}
            aria-label={t('search.filterHelper.propKeyLabel')}
            aria-invalid={showKeyError || undefined}
            aria-errormessage={showKeyError ? keyErrorId : undefined}
            autoFocus
          />
          {showKeyError ? (
            <p id={keyErrorId} role="alert" className="text-xs text-destructive">
              {t('search.filterHelper.propKeyInvalid')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('search.filterHelper.propValuePlaceholder')}
            aria-label={t('search.filterHelper.propValueLabel')}
            aria-invalid={showValueError || undefined}
            aria-errormessage={showValueError ? valueErrorId : undefined}
          />
          {showValueError ? (
            <p id={valueErrorId} role="alert" className="text-xs text-destructive">
              {t('search.filterHelper.propValueInvalid')}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex gap-2 justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          {t('search.filterHelper.back')}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {t('search.filterHelper.add')}
        </Button>
      </div>
    </form>
  )
}
