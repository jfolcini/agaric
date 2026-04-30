/**
 * PropertySetFilterForm — key picker for the `property-set` (PropertyIsSet)
 * filter category.  Uses a Select when known keys are available, falls
 * back to a free-form input otherwise.
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

export interface PropertySetFilterFormProps {
  propertyKeys: string[]
  ref?: React.Ref<FilterFormHandle>
}

export function PropertySetFilterForm({
  propertyKeys,
  ref,
}: PropertySetFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [propSetKey, setPropSetKey] = useState(propertyKeys[0] ?? '')

  useImperativeHandle(ref, () => ({ getState: () => ({ propSetKey }) }), [propSetKey])

  if (propertyKeys.length > 0) {
    return (
      <Select value={propSetKey} onValueChange={(val) => setPropSetKey(val)}>
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
      value={propSetKey}
      onChange={(e) => setPropSetKey(e.target.value)}
      aria-label={t('backlink.propertyKeyLabel')}
    />
  )
}
