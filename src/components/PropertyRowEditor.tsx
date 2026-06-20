/**
 * PropertyRowEditor — renders a single property row with typed input.
 *
 * Supports text, number, date, select, boolean, and ref value types with
 * inline editing. For select properties, includes a popover to manage the
 * set of allowed options (add / remove / save). For ref properties, includes
 * a page picker popover to search and select a linked page.
 *
 * The shared state (`localValue`, the date hook, the select-options popover
 * state, the ref-picker state, and the various callbacks) lives in
 * {@link usePropertyRowEditor}; this file is the orchestrator that dispatches
 * on `def.value_type` and renders the row layout (label + editor slot +
 * trailing affordances + delete button).
 *
 * Decomposition history: split out of a 575-LOC monolith.
 */

import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LOCKED_PROPERTY_OPTIONS } from '@/lib/property-save-utils'
import { formatPropertyName } from '@/lib/property-utils'

import type { PropertyDefinition, PropertyRow } from '../lib/tauri'
import { BooleanEditor } from './PropertyRowEditor/BooleanEditor'
import { DateEditor } from './PropertyRowEditor/DateEditor'
import { NumberEditor } from './PropertyRowEditor/NumberEditor'
import { RefEditor } from './PropertyRowEditor/RefEditor'
import { SelectEditor, SelectOptionsAffordance } from './PropertyRowEditor/SelectEditor'
import { TextEditor } from './PropertyRowEditor/TextEditor'
import {
  type UsePropertyRowEditorReturn,
  usePropertyRowEditor,
} from './PropertyRowEditor/usePropertyRowEditor'

export interface PropertyRowEditorProps {
  blockId: string
  prop: PropertyRow
  def: PropertyDefinition | undefined
  onSave: (rawValue: string) => void
  onDelete?: (() => void) | undefined
  onDefUpdated?: (updatedDef: PropertyDefinition) => void
  /** Called after a ref property value is saved (page selected via picker). */
  onRefSaved?: () => void
  /**
   * When provided, the ref-picker empty state offers a "Create new
   * page" affordance. The parent wires this to its create-page flow (the
   * editor needs the active space ID, which it does not have access to).
   */
  onCreateNewPage?: ((title: string) => void | Promise<void>) | undefined
}

export function PropertyRowEditor({
  blockId,
  prop,
  def,
  onSave,
  onDelete,
  onDefUpdated,
  onRefSaved,
  onCreateNewPage,
}: PropertyRowEditorProps) {
  const { t } = useTranslation()
  const bag = usePropertyRowEditor({
    blockId,
    prop,
    def,
    onSave,
    onDefUpdated,
    onRefSaved,
    onCreateNewPage,
  })
  const valueLabel = t('pageProperty.valueLabel', { key: prop.key })

  return (
    <div className="property-row flex items-center gap-2 text-sm">
      <Badge tone="outline" className="shrink-0 font-mono text-xs">
        {formatPropertyName(prop.key)}
      </Badge>
      <div className="flex-1">
        <EditorSlot
          bag={bag}
          prop={prop}
          onSave={onSave}
          valueLabel={valueLabel}
          hasCreateNewPage={onCreateNewPage != null}
        />
      </div>
      {bag.valueType === 'select' && (
        <SelectOptionsAffordance
          propKey={prop.key}
          locked={LOCKED_PROPERTY_OPTIONS.has(prop.key)}
          state={bag.selectOptions}
        />
      )}
      {onDelete && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={t('pageProperty.deletePropertyLabel', { key: prop.key })}
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}

interface EditorSlotProps {
  bag: UsePropertyRowEditorReturn
  prop: PropertyRow
  onSave: (rawValue: string) => void
  valueLabel: string
  hasCreateNewPage: boolean
}

function EditorSlot({ bag, prop, onSave, valueLabel, hasCreateNewPage }: EditorSlotProps) {
  switch (bag.valueType) {
    case 'ref':
      return (
        <RefEditor
          prop={prop}
          state={bag.refPicker}
          ariaLabel={valueLabel}
          hasCreateNewPage={hasCreateNewPage}
        />
      )
    case 'boolean':
      return <BooleanEditor prop={prop} onSave={onSave} />
    case 'select':
      return <SelectEditor state={bag.select} ariaLabel={valueLabel} />
    case 'number':
      return <NumberEditor state={bag.textLike} ariaLabel={valueLabel} />
    case 'date':
      return <DateEditor state={bag.date} ariaLabel={valueLabel} />
    default:
      return <TextEditor state={bag.textLike} ariaLabel={valueLabel} />
  }
}
