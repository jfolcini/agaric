/**
 * StatusFilterForm — todo-status selector for the `status` filter
 * category.  Shortcut for `PropertyText` with key `todo`.
 *
 * Issue #1647 follow-up — the value vocabulary is now the SINGLE canonical
 * task-state set shared with the search "State" form via
 * `components/filters/forms/stateVocabulary.ts`. This surface previously
 * kept a TODO/DOING/DONE shortlist; the maintainer decided to UNIFY the two
 * vocabularies, so Status now offers the full
 * TODO/DOING/DONE/WAITING/CANCELLED/none set (with translated labels). The
 * value flows downstream as a literal `PropertyText { key:'todo', op:'Eq' }`
 * string match, which accepts every value in the unified set.
 */

import type React from 'react'
import { useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FilterValueSelect } from '@/components/filters/forms/FilterValueSelect'
import { useStateFilterOptions } from '@/components/filters/forms/stateVocabulary'

import type { FilterFormHandle } from './types'

export interface StatusFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function StatusFilterForm({ ref }: StatusFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const statusOptions = useStateFilterOptions()
  const [statusValue, setStatusValue] = useState('TODO')

  useImperativeHandle(ref, () => ({ getState: () => ({ statusValue }) }), [statusValue])

  return (
    <FilterValueSelect
      options={statusOptions}
      value={statusValue}
      onValueChange={setStatusValue}
      ariaLabel={t('backlink.statusValueLabel')}
    />
  )
}
