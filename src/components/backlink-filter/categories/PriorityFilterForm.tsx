/**
 * PriorityFilterForm — priority selector for the `priority` filter
 * category.  Shortcut for `PropertyText` with key `priority`.
 */

import type React from 'react'
import { useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { FilterFormHandle } from './types'

export interface PriorityFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function PriorityFilterForm({ ref }: PriorityFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [priorityValue, setPriorityValue] = useState('1')

  useImperativeHandle(ref, () => ({ getState: () => ({ priorityValue }) }), [priorityValue])

  return (
    <Select value={priorityValue} onValueChange={(val) => setPriorityValue(val)}>
      <SelectTrigger size="sm" aria-label={t('backlink.priorityValueLabel')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="1">{t('backlink.highPriority')}</SelectItem>
        <SelectItem value="2">{t('backlink.mediumPriority')}</SelectItem>
        <SelectItem value="3">{t('backlink.lowPriority')}</SelectItem>
      </SelectContent>
    </Select>
  )
}
