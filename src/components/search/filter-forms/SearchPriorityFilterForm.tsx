/**
 * `priority:` / `not-priority:` builder form.
 *
 * Priority vocabulary is `PRIORITY_LEVELS` plus the appended `none`
 * sentinel — mirrors `PRIORITY_VALUES` in `useAutocompleteSources`. Emits a
 * `priority` or `notPriority` `FilterToken` and closes the popover.
 */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FilterValueSelect } from '@/components/filters/forms/FilterValueSelect'
import { IncludeExcludeToggle } from '@/components/search/filter-forms/IncludeExcludeToggle'
import { Button } from '@/components/ui/button'
import { PRIORITY_LEVELS } from '@/lib/priority-levels'
import type { FilterToken } from '@/lib/search-query'

const PRIORITY_VALUES: readonly string[] = [...PRIORITY_LEVELS, 'none']

export interface SearchPriorityFilterFormProps {
  onAddFilter: (token: FilterToken) => void
  onBack: () => void
}

export function SearchPriorityFilterForm({
  onAddFilter,
  onBack,
}: SearchPriorityFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [value, setValue] = useState<string>(PRIORITY_VALUES[0] ?? 'none')
  const [negate, setNegate] = useState(false)

  // Move focus into the sub-form on open (see SearchStateFilterForm).
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    triggerRef.current?.focus()
  }, [])

  function submit() {
    const token: FilterToken = negate
      ? { kind: 'notPriority', value, span: [0, 0] }
      : { kind: 'priority', value, span: [0, 0] }
    onAddFilter(token)
  }

  return (
    <form
      data-testid="priority-filter-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="text-sm font-medium">{t('search.filterCategory.priority')}</div>
      <div className="mt-2 flex flex-col gap-2">
        <IncludeExcludeToggle
          negate={negate}
          onChange={setNegate}
          label={t('search.filterHelper.matchMode')}
          includeLabel={t('search.filterHelper.include')}
          excludeLabel={t('search.filterHelper.exclude')}
        />
        <FilterValueSelect
          options={PRIORITY_VALUES.map((p) => ({ value: p }))}
          value={value}
          onValueChange={setValue}
          triggerRef={triggerRef}
          ariaLabel={t('search.filterHelper.priorityValueLabel')}
        />
      </div>
      <div className="mt-2 flex gap-2 justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          {t('search.filterHelper.back')}
        </Button>
        <Button type="submit" size="sm">
          {t('search.filterHelper.add')}
        </Button>
      </div>
    </form>
  )
}
