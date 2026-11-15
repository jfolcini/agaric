/**
 * One editable cell of a query table (#6743): a button showing the value that
 * opens, in place, the Properties table's editor for the key's type. Committing
 * is one write of that block, with the board's Undo toast (`recordBlockWrite`);
 * Escape closes the editor and writes nothing. A key that holds several values
 * (#6741) shows its items, a ref list its pages' titles, and opens the list
 * editor, each added or removed item one write of the whole list.
 */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { recordBlockWrite, writeBlockValue } from '@/components/AdvancedQuery/board-move'
import { EditorSlot } from '@/components/properties/PropertyRowEditor'
import { ListEditor } from '@/components/properties/PropertyRowEditor/ListEditor'
import { readCurrentValue } from '@/components/properties/PropertyRowEditor/shared'
import { usePropertyRowEditor } from '@/components/properties/PropertyRowEditor/usePropertyRowEditor'
import { useRefTitles } from '@/components/properties/useRefTitle'
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
  const valueLabel = t('pageProperty.valueLabel', { key: label })
  const current = readCurrentValue(prop)
  const { handleSave, handleDelete } = usePropertySave({
    blockId: block.id,
    // No `setProperties`: the row is read again by the refetch a write starts.
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
  const multiple = def?.multiple === true

  // A ref's picker loads its pages and opens; a select opens by itself; the
  // other controls take the focus the cell's button had, a list's its add
  // control, which follows its items' remove buttons.
  useEffect(() => {
    if (valueType === 'ref') openPicker()
    else if (multiple) {
      ;[...(wrapperRef.current?.querySelectorAll<HTMLElement>('input, button') ?? [])]
        .at(-1)
        ?.focus()
    } else if (valueType !== 'select') {
      wrapperRef.current?.querySelector<HTMLElement>('input, button')?.focus()
    }
  }, [valueType, multiple, openPicker])

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
      {def?.multiple ? (
        <ListEditor
          blockId={block.id}
          prop={prop}
          def={def}
          refPicker={bag.refPicker}
          ariaLabel={valueLabel}
          hasCreateNewPage={false}
          onWritten={(refs) => recordBlockWrite(block, refs, done)}
        />
      ) : (
        <EditorSlot
          bag={bag}
          prop={prop}
          onSave={commit}
          valueLabel={valueLabel}
          hasCreateNewPage={false}
          unfit={isUnfit(prop.key, valueForm(prop), prop.value_text, def)}
          onSelectClose={() => onClose(true)}
        />
      )}
    </div>
  )
}

export function QueryTableCell(props: QueryTableCellProps): React.ReactElement {
  const { label, prop, def } = props
  const { t } = useTranslation()
  const refItems = def?.value_type === 'ref' ? (prop.value_list?.map(String) ?? []) : []
  const titles = useRefTitles(refItems)
  const display = refItems.length > 0 ? titles : props.display
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
      className="touch-hit-area w-full rounded-sm text-left text-muted-foreground hover:bg-muted/60 focus-ring-visible"
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
