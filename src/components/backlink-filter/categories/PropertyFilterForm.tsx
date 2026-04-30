/**
 * PropertyFilterForm — typed key/op/value editor for the `property` filter
 * category.  Falls back to a free-form key input when no `propertyKeys`
 * are supplied (so unit tests can exercise the unknown-key validation
 * path).
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
import type { CompareOp } from '../../../lib/tauri'
import type { FilterFormHandle } from './types'

export interface PropertyFilterFormProps {
  propertyKeys: string[]
  ref?: React.Ref<FilterFormHandle>
}

export function PropertyFilterForm({
  propertyKeys,
  ref,
}: PropertyFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [propKey, setPropKey] = useState(propertyKeys[0] ?? '')
  const [propOp, setPropOp] = useState<CompareOp>('Eq')
  const [propValue, setPropValue] = useState('')
  const [propType, setPropType] = useState<'text' | 'num' | 'date'>('text')

  useImperativeHandle(ref, () => ({ getState: () => ({ propKey, propOp, propValue, propType }) }), [
    propKey,
    propOp,
    propValue,
    propType,
  ])

  return (
    <>
      {propertyKeys.length > 0 ? (
        <Select value={propKey} onValueChange={(val) => setPropKey(val)}>
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
      ) : (
        <SearchInput
          className="h-7 w-24 text-xs [@media(pointer:coarse)]:w-full"
          placeholder={t('backlink.keyPlaceholder')}
          value={propKey}
          onChange={(e) => setPropKey(e.target.value)}
          aria-label={t('backlink.propertyKeyLabel')}
        />
      )}
      <Select value={propOp} onValueChange={(val) => setPropOp(val as CompareOp)}>
        <SelectTrigger size="sm" aria-label={t('backlink.comparisonOpLabel')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="Eq">=</SelectItem>
          <SelectItem value="Neq">!=</SelectItem>
          <SelectItem value="Lt">&lt;</SelectItem>
          <SelectItem value="Gt">&gt;</SelectItem>
          <SelectItem value="Lte">&lt;=</SelectItem>
          <SelectItem value="Gte">&gt;=</SelectItem>
        </SelectContent>
      </Select>
      <Select value={propType} onValueChange={(val) => setPropType(val as 'text' | 'num' | 'date')}>
        <SelectTrigger size="sm" aria-label={t('backlink.propertyTypeLabel')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="text">{t('backlink.textType')}</SelectItem>
          <SelectItem value="num">{t('backlink.numberType')}</SelectItem>
          <SelectItem value="date">{t('backlink.dateType')}</SelectItem>
        </SelectContent>
      </Select>
      <SearchInput
        className="h-7 w-24 text-xs [@media(pointer:coarse)]:w-full"
        placeholder={t('backlink.valuePlaceholder')}
        value={propValue}
        onChange={(e) => setPropValue(e.target.value)}
        aria-label={t('backlink.propertyValueLabel')}
      />
    </>
  )
}
