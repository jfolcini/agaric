/**
 * BooleanEditor — renders a tri-state checkbox (true / false / indeterminate)
 * for boolean-typed properties. Saves immediately on toggle.
 */

import { useTranslation } from 'react-i18next'
import { Checkbox } from '@/components/ui/checkbox'
import type { PropertyRow } from '../../lib/tauri'

export interface BooleanEditorProps {
  prop: PropertyRow
  onSave: (rawValue: string) => void
}

export function BooleanEditor({ prop, onSave }: BooleanEditorProps) {
  const { t } = useTranslation()
  return (
    <Checkbox
      checked={prop.value_bool === null ? 'indeterminate' : prop.value_bool === 1}
      onCheckedChange={(checked) => {
        onSave(checked === true ? 'true' : 'false')
      }}
      aria-label={t('property.booleanToggle', { key: prop.key })}
    />
  )
}
