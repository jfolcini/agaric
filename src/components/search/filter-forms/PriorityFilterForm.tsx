/**
 * PEND-58g UX-A5 — `priority:` / `not-priority:` builder form.
 *
 * Priority vocabulary is the user-configurable `usePriorityLevels()` set
 * plus the appended `none` sentinel — mirrors the `priorityValues` memo
 * in `useAutocompleteSources`, NOT the backlink 1/2/3 shortlist. Emits a
 * `priority` or `notPriority` `FilterToken` and closes the popover.
 */

import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FilterValueSelect } from '@/components/filters/forms/FilterValueSelect'
import { Button } from '@/components/ui/button'
import { usePriorityLevels } from '@/hooks/usePriorityLevels'
import type { FilterToken } from '@/lib/search-query'

import { IncludeExcludeToggle } from './IncludeExcludeToggle'

export interface PriorityFilterFormProps {
  onAddFilter: (token: FilterToken) => void
  onBack: () => void
}

export function PriorityFilterForm({
  onAddFilter,
  onBack,
}: PriorityFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const priorityLevels = usePriorityLevels()
  const priorityValues = useMemo(() => [...priorityLevels, 'none'], [priorityLevels])
  const [value, setValue] = useState<string>(priorityValues[0] ?? 'none')
  const [negate, setNegate] = useState(false)

  // PEND-58g UX-A5 — move focus into the sub-form on open (see StateFilterForm).
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
          options={priorityValues.map((p) => ({ value: p }))}
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
