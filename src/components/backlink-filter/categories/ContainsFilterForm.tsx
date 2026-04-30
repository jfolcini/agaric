/**
 * ContainsFilterForm — free-text search for the `contains` filter category.
 */

import type React from 'react'
import { useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchInput } from '@/components/ui/search-input'
import type { FilterFormHandle } from './types'

export interface ContainsFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function ContainsFilterForm({ ref }: ContainsFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [containsQuery, setContainsQuery] = useState('')

  useImperativeHandle(ref, () => ({ getState: () => ({ containsQuery }) }), [containsQuery])

  return (
    <SearchInput
      className="h-7 w-40 text-xs [@media(pointer:coarse)]:w-full"
      placeholder={t('backlink.searchTextPlaceholder')}
      value={containsQuery}
      onChange={(e) => setContainsQuery(e.target.value)}
      aria-label={t('backlink.containsTextLabel')}
    />
  )
}
