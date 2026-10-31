/**
 * BooleanEditor — renders a tri-state checkbox (true / false / indeterminate)
 * for boolean-typed properties. Saves immediately on toggle.
 */

import { useTranslation } from 'react-i18next'

import { readCurrentValue } from '@/components/properties/PropertyRowEditor/shared'
import { Checkbox } from '@/components/ui/checkbox'
import type { PropertyRow } from '@/lib/bindings'

export interface BooleanEditorProps {
  prop: PropertyRow
  onSave: (rawValue: string) => void
}

export function BooleanEditor({ prop, onSave }: BooleanEditorProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        checked={prop.value_bool === null ? 'indeterminate' : prop.value_bool === 1}
        onCheckedChange={(checked) => {
          onSave(checked === true ? 'true' : 'false')
        }}
        aria-label={t('property.booleanToggle', { key: prop.key })}
      />
      {/* A value in another slot, which doesn't fit, stays readable beside the checkbox. */}
      {prop.value_bool === null && <span className="text-xs">{readCurrentValue(prop)}</span>}
    </div>
  )
}
