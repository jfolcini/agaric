/**
 * One editable cell of a query table (#6743): a button showing the value that
 * opens, in place, the Properties table's editor for the key's type. Committing
 * is one write of that block, with the board's Undo toast (`recordBlockWrite`);
 * Escape closes the editor and writes nothing.
 */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { recordBlockWrite, writeBlockValue } from '@/components/AdvancedQuery/board-move'
import { EditorSlot } from '@/components/properties/PropertyRowEditor'
import { readCurrentValue } from '@/components/properties/PropertyRowEditor/shared'
import { usePropertyRowEditor } from '@/components/properties/PropertyRowEditor/usePropertyRowEditor'
import { usePropertySave } from '@/hooks/usePropertySave'
import type { BlockRow, PropertyDefinition, PropertyRow } from '@/lib/bindings'
import { isUnfit, valueForm } from '@/lib/property-fit'

export interface QueryTableCellProps {
  block: BlockRow
  /** The column's header, which names the cell and its toast. */
  label: string
  /** The cell's value as the block holds it; every slot null when it holds none. */
  prop: PropertyRow
  def: PropertyDefinition | undefined
  /** The value as the table shows it; empty when the block holds none. */
  display: string
}

/** The row is read again by the refetch a write starts, not from the save's reply. */
function ignoreProperties(): void {}

function CellEditor({
  block,
  label,
  prop,
  def,
  onClose,
}: Omit<QueryTableCellProps, 'display'> & {
  onClose: (restoreFocus: boolean) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const cancelled = useRef(false)
  const done = t('queryResult.cell.updated', { column: label })
  const current = readCurrentValue(prop)
  const { handleSave, handleDelete } = usePropertySave({
    blockId: block.id,
    setProperties: ignoreProperties,
    logTag: 'QueryTableCell',
    onWritten: (refs) => recordBlockWrite(block, refs, done),
  })

  const commit = (value: string): void => {
    if (cancelled.current) return
    onClose(true)
    if (value === current) return
    if (prop.key === 'todo_state') {
      // `set_todo_state` stamps and recurs; `set_property` is for the other keys.
      void writeBlockValue(block, value === '' ? {} : { value }, {
        done,
        failed: t('property.saveFailed'),
      })
    } else if (value === '') {
      void handleDelete(prop.key)
    } else {
      void handleSave(prop.key, value, def?.value_type ?? 'text')
    }
  }

  const bag = usePropertyRowEditor({
    blockId: block.id,
    prop,
    def,
    onSave: commit,
    onRefSaved: (refs) => recordBlockWrite(block, refs, done),
  })
  const { valueType } = bag
  const { open: pickerOpen, handleOpen: openPicker } = bag.refPicker

  // A ref's picker loads its pages and opens; a select opens by itself; the
  // other controls take the focus the cell's button had.
  useEffect(() => {
    if (valueType === 'ref') openPicker()
    else if (valueType !== 'select') {
      wrapperRef.current?.querySelector<HTMLElement>('input, button')?.focus()
    }
  }, [valueType, openPicker])

  // The picker closing, on a pick or a dismissal, closes the cell with it.
  const pickerWasOpen = useRef(false)
  useEffect(() => {
    if (pickerOpen) pickerWasOpen.current = true
    else if (pickerWasOpen.current) onClose(true)
  }, [pickerOpen, onClose])

  return (
    /* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the keys and the blur bubble up from the editor's own control; the wrapper takes no focus itself */
    <div
      ref={wrapperRef}
      onKeyDown={(e) => {
        // Enter in a field commits by blurring it, which hands the focus back
        // to the cell's button; unprevented, the same key press would then
        // press that button and open the cell again.
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault()
        if (e.key !== 'Escape') return
        e.stopPropagation()
        cancelled.current = true
        onClose(true)
      }}
      onBlur={(e) => {
        // A text field left behind closes the cell. A picker's own field lives
        // in a portal, outside this element, and leaving it is the picker's affair.
        const inCell = (node: EventTarget | null): boolean =>
          node instanceof Node && e.currentTarget.contains(node)
        if (e.target instanceof HTMLInputElement && inCell(e.target) && !inCell(e.relatedTarget)) {
          onClose(e.relatedTarget === null)
        }
      }}
    >
      <EditorSlot
        bag={bag}
        prop={prop}
        onSave={commit}
        valueLabel={t('pageProperty.valueLabel', { key: label })}
        hasCreateNewPage={false}
        unfit={isUnfit(prop.key, valueForm(prop), prop.value_text, def)}
        onSelectClose={() => onClose(true)}
      />
    </div>
  )
}

export function QueryTableCell(props: QueryTableCellProps): React.ReactElement {
  const { label, display } = props
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)

  useEffect(() => {
    if (open || !refocus.current) return
    refocus.current = false
    buttonRef.current?.focus()
  }, [open])

  if (open) {
    return (
      <CellEditor
        {...props}
        onClose={(restoreFocus) => {
          refocus.current = restoreFocus
          setOpen(false)
        }}
      />
    )
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      className="touch-target w-full rounded-sm text-left text-muted-foreground hover:bg-muted/60 focus-ring-visible"
      aria-label={
        display === ''
          ? t('queryResult.cell.set', { column: label })
          : t('queryResult.cell.edit', { column: label, value: display })
      }
      onClick={(e) => {
        e.stopPropagation()
        setOpen(true)
      }}
    >
      {display || '—'}
    </button>
  )
}
