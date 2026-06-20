/**
 * PriorityFilterForm — priority selector for the `priority` filter
 * category.  Shortcut for `PropertyText` with key `priority`.
 *
 * Issue #1647 — the value control is the shared `FilterValueSelect`, but
 * the vocabulary is THIS surface's fixed 1/2/3 shortlist (with translated
 * high/medium/low labels), NOT the search `usePriorityLevels()` vocab.
 */

import type React from 'react'
import { useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FilterValueSelect } from '@/components/filters/forms/FilterValueSelect'

import type { FilterFormHandle } from './types'

export interface PriorityFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function PriorityFilterForm({ ref }: PriorityFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [priorityValue, setPriorityValue] = useState('1')

  useImperativeHandle(ref, () => ({ getState: () => ({ priorityValue }) }), [priorityValue])

  return (
    <FilterValueSelect
      options={[
        { value: '1', label: t('backlink.highPriority') },
        { value: '2', label: t('backlink.mediumPriority') },
        { value: '3', label: t('backlink.lowPriority') },
      ]}
      value={priorityValue}
      onValueChange={setPriorityValue}
      ariaLabel={t('backlink.priorityValueLabel')}
    />
  )
}
