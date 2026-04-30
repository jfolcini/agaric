/**
 * DateFilterForm — `after`/`before` date range for the `date` filter
 * category (CreatedInRange).
 */

import type React from 'react'
import { useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchInput } from '@/components/ui/search-input'
import type { FilterFormHandle } from './types'

export interface DateFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function DateFilterForm({ ref }: DateFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [dateAfter, setDateAfter] = useState('')
  const [dateBefore, setDateBefore] = useState('')

  useImperativeHandle(ref, () => ({ getState: () => ({ dateAfter, dateBefore }) }), [
    dateAfter,
    dateBefore,
  ])

  return (
    <>
      <SearchInput
        type="date"
        className="h-7 w-36 text-xs [@media(pointer:coarse)]:w-full"
        value={dateAfter}
        onChange={(e) => setDateAfter(e.target.value)}
        aria-label={t('backlink.dateAfterLabel')}
      />
      <span className="text-xs text-muted-foreground">{t('backlink.dateTo')}</span>
      <SearchInput
        type="date"
        className="h-7 w-36 text-xs [@media(pointer:coarse)]:w-full"
        value={dateBefore}
        onChange={(e) => setDateBefore(e.target.value)}
        aria-label={t('backlink.dateBeforeLabel')}
      />
    </>
  )
}
