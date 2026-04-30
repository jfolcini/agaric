/**
 * PropertyEmptyFilterForm — key picker for the `property-empty`
 * (PropertyIsEmpty) filter category.
 */

import type React from 'react'
import { useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchInput } from '@/components/ui/search-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { FilterFormHandle } from './types'

export interface PropertyEmptyFilterFormProps {
  propertyKeys: string[]
  ref?: React.Ref<FilterFormHandle>
}

export function PropertyEmptyFilterForm({
  propertyKeys,
  ref,
}: PropertyEmptyFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [propEmptyKey, setPropEmptyKey] = useState(propertyKeys[0] ?? '')

  useImperativeHandle(ref, () => ({ getState: () => ({ propEmptyKey }) }), [propEmptyKey])

  if (propertyKeys.length > 0) {
    return (
      <Select value={propEmptyKey} onValueChange={(val) => setPropEmptyKey(val)}>
        <SelectTrigger size="sm" aria-label={t('backlink.propertyKeyLabel')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {propertyKeys.map((k) => (
            <SelectItem key={k} value={k}>
              {k}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  return (
    <SearchInput
      className="h-7 w-24 text-xs [@media(pointer:coarse)]:w-full"
      placeholder={t('backlink.keyPlaceholder')}
      value={propEmptyKey}
      onChange={(e) => setPropEmptyKey(e.target.value)}
      aria-label={t('backlink.propertyKeyLabel')}
    />
  )
}
