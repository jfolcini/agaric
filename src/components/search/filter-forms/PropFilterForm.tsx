/**
 * PEND-58g UX-A5 — `prop:key=value` / `not-prop:key=value` builder form.
 *
 * Free-form key + value text inputs (the property vocabulary is
 * space-scoped and not enumerated here) plus an include/exclude toggle.
 * Emits a `prop` or `notProp` `FilterToken` and closes the popover.
 */

import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { FilterToken } from '@/lib/search-query'
import { IncludeExcludeToggle } from './IncludeExcludeToggle'

export interface PropFilterFormProps {
  onAddFilter: (token: FilterToken) => void
  onBack: () => void
}

export function PropFilterForm({ onAddFilter, onBack }: PropFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [negate, setNegate] = useState(false)

  const canSubmit = key.trim() !== '' && value.trim() !== ''

  function submit() {
    const k = key.trim()
    const v = value.trim()
    if (!k || !v) return
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
        <Input
          type="text"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t('search.filterHelper.propKeyPlaceholder')}
          aria-label={t('search.filterHelper.propKeyLabel')}
          autoFocus
        />
        <Input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('search.filterHelper.propValuePlaceholder')}
          aria-label={t('search.filterHelper.propValueLabel')}
        />
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
