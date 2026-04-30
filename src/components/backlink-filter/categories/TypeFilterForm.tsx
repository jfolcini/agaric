/**
 * TypeFilterForm — block-type selector for the `type` filter category.
 * Owns its own `blockType` state and exposes a `getState()` slice via ref.
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

export interface TypeFilterFormProps {
  ref?: React.Ref<FilterFormHandle>
}

export function TypeFilterForm({ ref }: TypeFilterFormProps): React.ReactElement {
  const { t } = useTranslation()
  const [blockType, setBlockType] = useState('content')

  useImperativeHandle(ref, () => ({ getState: () => ({ blockType }) }), [blockType])

  return (
    <Select value={blockType} onValueChange={(val) => setBlockType(val)}>
      <SelectTrigger size="sm" aria-label={t('backlink.blockTypeValueLabel')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="content">{t('backlink.contentType')}</SelectItem>
        <SelectItem value="page">{t('backlink.pageType')}</SelectItem>
        <SelectItem value="tag">{t('backlink.tagType')}</SelectItem>
      </SelectContent>
    </Select>
  )
}
