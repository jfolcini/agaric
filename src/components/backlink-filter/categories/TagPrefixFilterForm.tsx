/**
 * TagPrefixFilterForm — prefix input for the `tag-prefix` (HasTagPrefix)
 * filter category.
 */

import type React from 'react'
import { useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { FilterFormHandle } from '@/components/backlink-filter/categories/types'
import { SearchInput } from '@/components/ui/search-input'

export interface TagPrefixFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function TagPrefixFilterForm({ ref }: TagPrefixFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [prefixValue, setPrefixValue] = useState('')

  useImperativeHandle(ref, () => ({ getState: () => ({ prefixValue }) }), [prefixValue])

  return (
    <SearchInput
      className="h-7 w-40 text-xs [@media(pointer:coarse)]:w-full"
      placeholder={t('backlink.tagPrefixPlaceholder')}
      value={prefixValue}
      onChange={(e) => setPrefixValue(e.target.value)}
      aria-label={t('backlink.tagPrefixLabel')}
      maxLength={100}
    />
  )
}
