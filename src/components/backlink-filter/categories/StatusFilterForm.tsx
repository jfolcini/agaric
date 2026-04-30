/**
 * StatusFilterForm — todo-status selector for the `status` filter
 * category.  Shortcut for `PropertyText` with key `todo`.
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

export interface StatusFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function StatusFilterForm({ ref }: StatusFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [statusValue, setStatusValue] = useState('TODO')

  useImperativeHandle(ref, () => ({ getState: () => ({ statusValue }) }), [statusValue])

  return (
    <Select value={statusValue} onValueChange={(val) => setStatusValue(val)}>
      <SelectTrigger size="sm" aria-label={t('backlink.statusValueLabel')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="TODO">{t('backlink.todoStatus')}</SelectItem>
        <SelectItem value="DOING">{t('backlink.doingStatus')}</SelectItem>
        <SelectItem value="DONE">{t('backlink.doneStatus')}</SelectItem>
      </SelectContent>
    </Select>
  )
}
