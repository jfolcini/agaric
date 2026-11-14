/**
 * ListEditor — the items of a property whose definition holds several values
 * (#6741): each item a removable chip, then an add control of the item type
 * (text and url an input, number a number input, date the date input, select
 * the options not yet in the list, ref the page picker). Every change writes
 * the whole list (`savePropertyList`); removing the last item deletes the
 * property. A ref item shows its target's title.
 */

import { X } from 'lucide-react'
import type React from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { RefEditor } from '@/components/properties/PropertyRowEditor/RefEditor'
import { parseSelectOptions } from '@/components/properties/PropertyRowEditor/shared'
import type { RefPickerEditorState } from '@/components/properties/PropertyRowEditor/usePropertyRowEditor'
import { useRefTitle } from '@/components/properties/useRefTitle'
import { Badge } from '@/components/ui/badge'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useDateInput } from '@/hooks/useDateInput'
import type { OpRef, PropertyDefinition, PropertyList, PropertyRow } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { savePropertyList } from '@/lib/property-save-utils'

export interface ListEditorProps {
  blockId: string
  prop: PropertyRow
  def: PropertyDefinition
  refPicker: RefPickerEditorState
  /** The list's name, `{{key}} value`. */
  ariaLabel: string
  hasCreateNewPage: boolean
  onWritten?: ((refs: OpRef[]) => void) | undefined
}

export function ListEditor({
  blockId,
  prop,
  def,
  refPicker,
  ariaLabel,
  hasCreateNewPage,
  onWritten,
}: ListEditorProps): React.ReactElement {
  const { t } = useTranslation()
  const items = prop.value_list ?? []
  const [busy, setBusy] = useState(false)
  const writing = useRef(false)

  const write = async (next: PropertyList): Promise<boolean> => {
    if (writing.current) return false
    writing.current = true
    setBusy(true)
    try {
      onWritten?.(await savePropertyList(blockId, prop.key, next))
      return true
    } catch (err) {
      logger.error('ListEditor', 'Failed to save list property', { blockId, key: prop.key }, err)
      notify.error(t('pageProperty.saveFailed'))
      return false
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const addLabel = t('property.addListItem', { key: prop.key })
  return (
    <fieldset
      aria-label={ariaLabel}
      className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-none p-0"
    >
      {items.map((item, index) => (
        <ListItemChip
          // oxlint-disable-next-line react/no-array-index-key -- a list may hold one value twice, so the position is the only identity an item has
          key={`${index}:${String(item)}`}
          item={item}
          isRef={def.value_type === 'ref'}
          disabled={busy}
          onRemove={() => void write(items.filter((_, i) => i !== index))}
        />
      ))}
      <AddItemControl
        def={def}
        items={items}
        refPicker={refPicker}
        ariaLabel={addLabel}
        hasCreateNewPage={hasCreateNewPage}
        disabled={busy}
        onAdd={(item) => write([...items, item])}
      />
    </fieldset>
  )
}

interface ListItemChipProps {
  item: PropertyList[number]
  isRef: boolean
  disabled: boolean
  onRemove: () => void
}

function ListItemChip({ item, isRef, disabled, onRemove }: ListItemChipProps): React.ReactElement {
  const { t } = useTranslation()
  const title = useRefTitle(isRef && typeof item === 'string' ? item : null)
  const label = title ?? String(item)
  const removeLabel = t('property.removeListItem', { item: label })
  return (
    <Badge tone="secondary" className="max-w-full gap-0.5 pr-0.5">
      <span className="truncate">{label}</span>
      <IconButton
        variant="ghost"
        size="icon-xs"
        className="size-4 shrink-0 text-muted-foreground hover:text-destructive"
        disabled={disabled}
        onClick={onRemove}
        tooltip={removeLabel}
        ariaLabel={removeLabel}
      >
        <X className="h-3 w-3" />
      </IconButton>
    </Badge>
  )
}

interface AddItemControlProps {
  def: PropertyDefinition
  items: PropertyList
  refPicker: RefPickerEditorState
  ariaLabel: string
  hasCreateNewPage: boolean
  disabled: boolean
  /** Resolves whether the item was written. */
  onAdd: (item: string | number) => Promise<boolean>
}

function AddItemControl(props: AddItemControlProps): React.ReactElement {
  const { def, items, refPicker, ariaLabel, hasCreateNewPage, disabled, onAdd } = props
  switch (def.value_type) {
    case 'ref': {
      return (
        <div className="min-w-32 flex-1">
          <RefEditor
            prop={{
              key: def.key,
              value_text: null,
              value_num: null,
              value_date: null,
              value_ref: null,
              value_bool: null,
            }}
            state={refPicker}
            ariaLabel={ariaLabel}
            hasCreateNewPage={hasCreateNewPage}
          />
        </div>
      )
    }
    case 'select': {
      return <AddSelectItem def={def} items={items} ariaLabel={ariaLabel} onAdd={onAdd} />
    }
    case 'date': {
      return <AddDateItem ariaLabel={ariaLabel} disabled={disabled} onAdd={onAdd} />
    }
    default: {
      return (
        <AddTypedItem
          number={def.value_type === 'number'}
          ariaLabel={ariaLabel}
          disabled={disabled}
          onAdd={onAdd}
        />
      )
    }
  }
}

function AddTypedItem({
  number,
  ariaLabel,
  disabled,
  onAdd,
}: {
  number: boolean
  ariaLabel: string
  disabled: boolean
  onAdd: (item: string | number) => Promise<boolean>
}): React.ReactElement {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const add = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '') return
    const item = number ? Number(text) : text
    if (number && Number.isNaN(item)) {
      notify.error(t('property.invalidNumber'))
      return
    }
    if (await onAdd(item)) setDraft('')
  }
  return (
    <Input
      className="h-7 min-w-24 flex-1 text-xs"
      type={number ? 'number' : 'text'}
      value={draft}
      placeholder={t('property.addListItemPlaceholder')}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        void add()
      }}
      aria-label={ariaLabel}
    />
  )
}

function AddDateItem({
  ariaLabel,
  disabled,
  onAdd,
}: {
  ariaLabel: string
  disabled: boolean
  onAdd: (item: string) => Promise<boolean>
}): React.ReactElement {
  const { t } = useTranslation()
  const { dateInput, setDateInput, datePreview, handleChange, handleBlur } = useDateInput({
    onSave: (iso) => {
      if (iso === '') return
      void onAdd(iso).then((added) => {
        if (added) setDateInput('')
      })
    },
  })
  return (
    <div className="min-w-24 flex-1">
      <Input
        className="h-7 text-xs"
        type="text"
        value={dateInput}
        placeholder={t('property.datePlaceholder')}
        disabled={disabled}
        onChange={handleChange}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          handleBlur()
        }}
        aria-label={ariaLabel}
      />
      {datePreview && <p className="mt-0.5 text-xs text-muted-foreground">{datePreview}</p>}
    </div>
  )
}

function AddSelectItem({
  def,
  items,
  ariaLabel,
  onAdd,
}: {
  def: PropertyDefinition
  items: PropertyList
  ariaLabel: string
  onAdd: (item: string) => Promise<boolean>
}): React.ReactElement {
  const { t } = useTranslation()
  const left = parseSelectOptions(def).filter((opt) => !items.includes(opt))
  return (
    <Select value="" onValueChange={(opt) => void onAdd(opt)} disabled={left.length === 0}>
      <SelectTrigger className="h-7 min-w-24 flex-1 text-xs" aria-label={ariaLabel}>
        <SelectValue placeholder={t('property.addListItemPlaceholder')} />
      </SelectTrigger>
      <SelectContent>
        {left.map((opt) => (
          <SelectItem key={opt} value={opt}>
            {opt}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
