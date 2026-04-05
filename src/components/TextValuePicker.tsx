import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'

export function TextValuePicker({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (values: string[]) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [text, setText] = useState(selected[0] ?? '')
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        className="h-7 text-xs"
        placeholder={t('agendaFilter.tagPlaceholder')}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (e.target.value.trim()) {
            onChange([e.target.value.trim()])
          } else {
            onChange([])
          }
        }}
        aria-label={t('agendaFilter.tagName')}
      />
    </div>
  )
}
