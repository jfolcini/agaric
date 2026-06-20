/**
 * PEND-58g UX-A5 — `state:` / `not-state:` builder form.
 *
 * Issue #1647 follow-up — the State vocabulary is now the SINGLE canonical
 * task-state set shared with the backlink "Status" form via
 * `components/filters/forms/stateVocabulary.ts` (value set sourced from
 * `STATE_VALUES`, with translated labels). Emits a `state` or `notState`
 * `FilterToken` with `span: [0, 0]` and closes the popover.
 */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FilterValueSelect } from '@/components/filters/forms/FilterValueSelect'
import {
  STATE_FILTER_VALUES,
  useStateFilterOptions,
} from '@/components/filters/forms/stateVocabulary'
import { Button } from '@/components/ui/button'
import type { FilterToken } from '@/lib/search-query'

import { IncludeExcludeToggle } from './IncludeExcludeToggle'

export interface StateFilterFormProps {
  onAddFilter: (token: FilterToken) => void
  onBack: () => void
}

export function StateFilterForm({ onAddFilter, onBack }: StateFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const stateOptions = useStateFilterOptions()
  const [value, setValue] = useState<string>(STATE_FILTER_VALUES[0])
  const [negate, setNegate] = useState(false)

  // PEND-58g UX-A5 — move focus into the sub-form on open so keyboard users
  // aren't stranded on document.body when the clicked menu item unmounts.
  // (Radix's PopoverContent only auto-focuses on the initial open, not on
  // in-place content swaps, and `autoFocus` is unreliable on the Select
  // trigger — see FilterHelperPopover.)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    triggerRef.current?.focus()
  }, [])

  function submit() {
    const token: FilterToken = negate
      ? { kind: 'notState', value, span: [0, 0] }
      : { kind: 'state', value, span: [0, 0] }
    onAddFilter(token)
  }

  return (
    <form
      data-testid="state-filter-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="text-sm font-medium">{t('search.filterCategory.state')}</div>
      <div className="mt-2 flex flex-col gap-2">
        <IncludeExcludeToggle
          negate={negate}
          onChange={setNegate}
          label={t('search.filterHelper.matchMode')}
          includeLabel={t('search.filterHelper.include')}
          excludeLabel={t('search.filterHelper.exclude')}
        />
        <FilterValueSelect
          options={stateOptions}
          value={value}
          onValueChange={setValue}
          triggerRef={triggerRef}
          ariaLabel={t('search.filterHelper.stateValueLabel')}
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
