/**
 * SuggestedPropertyRows — the keys a block's tags offer it (#6755), each an
 * empty row with the editor of its definition and the tag it came from
 * ("from #book"). A key with no definition in the space is a text row.
 *
 * Nothing is written until a row is filled: an untouched or emptied row saves
 * nothing, and removing one only hides it here.
 */

import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PropertyRowEditor } from '@/components/properties/PropertyRowEditor'
import type { PropertyDefinition, PropertyRow, SuggestedProperty } from '@/lib/bindings'

export interface SuggestedPropertyRowsProps {
  blockId: string
  suggestions: SuggestedProperty[]
  definitions: PropertyDefinition[]
  /** Keys the block shows a row for already, held or draft. */
  shownKeys: ReadonlySet<string>
  onSave: (key: string, def: PropertyDefinition | undefined, rawValue: string) => void
  /** A ref's page or a list's item written by the row's own editor. */
  onWritten: () => void
}

function emptyRow(key: string): PropertyRow {
  return {
    key,
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
  }
}

export function SuggestedPropertyRows({
  blockId,
  suggestions,
  definitions,
  shownKeys,
  onSave,
  onWritten,
}: SuggestedPropertyRowsProps): React.ReactElement | null {
  const { t } = useTranslation()
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const rows = suggestions.filter((s) => !shownKeys.has(s.key) && !hidden.has(s.key))
  if (rows.length === 0) return null
  return (
    <>
      {rows.map((s) => {
        const def = definitions.find((d) => d.key === s.key)
        return (
          <div key={s.key} data-testid={`suggested-property-${s.key}`}>
            <p className="text-xs text-muted-foreground">
              {t('property.suggestedFrom', { tag: s.tag_name })}
            </p>
            <PropertyRowEditor
              blockId={blockId}
              prop={emptyRow(s.key)}
              def={def}
              forceSaveOnBlur
              onSave={(raw) => {
                if (raw.trim() !== '') onSave(s.key, def, raw)
              }}
              onDelete={() => setHidden((prev) => new Set(prev).add(s.key))}
              onRefSaved={onWritten}
            />
          </div>
        )
      })}
    </>
  )
}
