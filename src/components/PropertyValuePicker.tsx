import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { logger } from '../lib/logger'
import { listPropertyKeys } from '../lib/tauri'

export function PropertyValuePicker({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (values: string[]) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [propertyKeys, setPropertyKeys] = useState<string[]>([])
  const [propertyKey, setPropertyKey] = useState(() => {
    if (selected.length > 0) {
      const first = selected[0] as string
      const colonIdx = first.indexOf(':')
      return colonIdx > 0 ? first.slice(0, colonIdx) : first
    }
    return ''
  })
  const [propertyValue, setPropertyValue] = useState(() => {
    if (selected.length > 0) {
      const first = selected[0] as string
      const colonIdx = first.indexOf(':')
      return colonIdx > 0 ? first.slice(colonIdx + 1) : ''
    }
    return ''
  })

  useEffect(() => {
    listPropertyKeys()
      .then(setPropertyKeys)
      .catch((err) => {
        logger.warn('PropertyValuePicker', 'failed to load property keys', undefined, err)
        setPropertyKeys([])
      })
  }, [])

  useEffect(() => {
    if (propertyKey) {
      const filterValue = propertyValue ? `${propertyKey}:${propertyValue}` : propertyKey
      onChange([filterValue])
    } else {
      onChange([])
    }
  }, [propertyKey, propertyValue, onChange])

  return (
    <div className="flex flex-col gap-2">
      <Label size="xs" muted={false} htmlFor="prop-filter-key">
        {t('agendaFilter.propertyKey')}
      </Label>
      <Select
        value={propertyKey || '__none__'}
        onValueChange={(val) => setPropertyKey(val === '__none__' ? '' : val)}
      >
        <SelectTrigger id="prop-filter-key" size="sm" className="block w-full">
          <SelectValue placeholder={t('agendaFilter.selectProperty')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t('agendaFilter.selectProperty')}</SelectItem>
          {propertyKeys.map((k) => (
            <SelectItem key={k} value={k}>
              {k}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Label size="xs" muted={false} htmlFor="prop-filter-value">
        {t('agendaFilter.propertyValue')}
      </Label>
      <Input
        id="prop-filter-value"
        className="h-7 text-xs"
        placeholder={t('agendaFilter.propertyValuePlaceholder')}
        value={propertyValue}
        onChange={(e) => setPropertyValue(e.target.value)}
      />
    </div>
  )
}
