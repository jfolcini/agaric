/**
 * PropertyDefinitionSheet -- Settings › Properties' one place for a user
 * property (#7040), opened by tapping its row: its name and a select's
 * options, written together on Save, then the actions that change or end it
 * (Change type, Merge, Copy to another space, Delete), each its own dialog
 * over this one; a written type change, merge or delete closes this one too,
 * back to the list that shows it. A dialog on a wide screen, a bottom sheet on
 * a phone.
 *
 * A rename (`rename_property_key`) moves the definition and every value the
 * space's blocks hold under the key, Trash included, in one op the toast can
 * undo; the field declines what the backend would refuse anyway, a key the
 * space already defines (a built-in included) or one the app keeps for itself.
 * Renaming one option is written at once, as in the block row's options editor.
 */

import { Slot } from 'radix-ui'
import type React from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ChangePropertyType } from '@/components/properties/ChangePropertyType'
import { CopyDefinitionToSpace } from '@/components/properties/CopyDefinitionToSpace'
import { MergePropertyDefinition } from '@/components/properties/MergePropertyDefinition'
import {
  notifyDefinitionWrite,
  renameSelectOption,
} from '@/components/properties/notify-definition-write'
import { SelectOptionsList } from '@/components/properties/PropertyRowEditor/SelectEditor'
import { parseSelectOptions } from '@/components/properties/PropertyRowEditor/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogBody } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { useSelectOptionsDraft } from '@/hooks/useSelectOptionsDraft'
import { unwrap } from '@/lib/app-error'
import type { PropertyDefinition } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { NON_DELETABLE_PROPERTIES } from '@/lib/property-save-utils'
import { formatPropertyName, valueTypeLabel } from '@/lib/property-utils'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'

export interface PropertyDefinitionSheetProps {
  definition: PropertyDefinition
  spaceId: string
  /** The space's definitions, built-ins included: names the rename cannot take. */
  definitions: readonly PropertyDefinition[]
  /** Read the list again after a write or its undo. */
  onChanged: () => void
  /** Ask to delete the property; the list owns the confirmation. */
  onDelete: () => void
  /** The row's control that opens the sheet. */
  trigger: React.ReactElement
}

export function PropertyDefinitionSheet({
  definition,
  spaceId,
  definitions,
  onChanged,
  onDelete,
  trigger,
}: PropertyDefinitionSheetProps): React.ReactElement {
  const { t } = useTranslation()
  const parts = useDialogOrSheet('dialog')
  const nameId = useId()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(definition.key)
  const [saving, setSaving] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Set when Delete hands over to the list's confirmation, which then holds focus.
  const handedOff = useRef(false)
  const { key } = definition
  const isSelect = definition.value_type === 'select'
  const saved = useMemo(() => parseSelectOptions(definition), [definition])

  const writeOptions = async (next: string[]): Promise<boolean> => {
    try {
      const { op_refs } = unwrap(
        await commands.updatePropertyDefOptions(spaceId, key, JSON.stringify(next)),
      )
      notifyDefinitionWrite(t('propertiesView.optionsSaved'), op_refs, onChanged)
      onChanged()
      return true
    } catch (error) {
      reportIpcErrorWithReason('PropertyDefinitionSheet', 'property.errorUpdate', error, t, {
        key,
      })
      return false
    }
  }
  const options = useSelectOptionsDraft(saved, {
    save: writeOptions,
    rename: (from, to) => renameSelectOption(spaceId, key, from, to, onChanged),
  })

  const rename = async (newKey: string): Promise<boolean> => {
    try {
      const { op_refs } = unwrap(await commands.renamePropertyKey(spaceId, key, newKey))
      notifyDefinitionWrite(
        t('propertiesView.renamed', { from: key, to: newKey }),
        op_refs,
        onChanged,
      )
      onChanged()
      return true
    } catch (error) {
      // The reason names what is in the way, e.g. blocks already holding the new key.
      reportIpcErrorWithReason('PropertyDefinitionSheet', 'propertiesView.renameFailed', error, t, {
        key,
        newKey,
      })
      return false
    }
  }

  const nextName = name.trim()
  const nameError =
    INTERNAL_PROPERTY_KEYS.has(nextName) || NON_DELETABLE_PROPERTIES.has(nextName)
      ? t('propertiesView.reservedKey', { key: nextName })
      : nextName !== key && definitions.some((d) => d.key === nextName)
        ? t('propertiesView.duplicateKey')
        : null
  const nameChanged = nextName !== key
  const optionsChanged =
    isSelect &&
    (options.options.length !== saved.length || options.options.some((o, i) => o !== saved[i]))
  const canSave =
    !saving && nextName !== '' && nameError === null && (nameChanged || optionsChanged)

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      // The options first: a rename moves the definition, options and all.
      if (optionsChanged && !(await writeOptions(options.options))) return
      if (nameChanged && !(await rename(nextName))) return
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const { Root, Content, Header, Title, Description, Footer } = parts
  const action = 'w-full justify-start'
  const body = (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>{t('propertiesView.nameLabel')}</Label>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              // `save` reports its own failure; never rejects.
              void save()
            }
          }}
          aria-invalid={nameError !== null}
          aria-describedby={
            nameError !== null ? `${nameId}-error` : nameChanged ? `${nameId}-hint` : undefined
          }
        />
        {nameError !== null ? (
          <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive">
            {nameError}
          </p>
        ) : (
          nameChanged && (
            <p id={`${nameId}-hint`} className="text-xs text-muted-foreground">
              {t('propertiesView.renameDescription', { key })}
            </p>
          )
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{t('propertiesView.typeLabel')}</span>
          <Badge tone="secondary">{valueTypeLabel(definition, t)}</Badge>
        </div>
        <ChangePropertyType
          definition={definition}
          spaceId={spaceId}
          onChanged={onChanged}
          onDone={() => setOpen(false)}
          trigger={
            <Button variant="outline" size="sm">
              {t('propertiesView.changeTypeAction')}
            </Button>
          }
        />
      </div>
      {isSelect && (
        <div className="space-y-1.5">
          <span className="font-medium">{t('propertiesView.optionsLabel')}</span>
          <SelectOptionsList state={options} className="max-h-60" />
        </div>
      )}
      <div className="flex flex-col border-t border-border pt-2">
        <MergePropertyDefinition
          definition={definition}
          spaceId={spaceId}
          definitions={definitions}
          onChanged={onChanged}
          trigger={
            <Button variant="ghost" className={action}>
              {t('propertiesView.mergeAction')}
            </Button>
          }
        />
        <CopyDefinitionToSpace
          definition={definition}
          fromSpaceId={spaceId}
          trigger={
            <Button variant="ghost" className={action}>
              {t('propertiesView.copyAction')}
            </Button>
          }
        />
        <Button
          variant="ghost"
          className={`${action} text-destructive hover:text-destructive`}
          onClick={() => {
            handedOff.current = true
            setOpen(false)
            onDelete()
          }}
        >
          {t('propertiesView.deleteAction')}
        </Button>
      </div>
    </div>
  )

  return (
    <>
      <Slot.Root
        ref={triggerRef}
        onClick={() => {
          // From the definition as it stands now: a write or its undo may have moved it.
          setName(key)
          options.handleOpen()
          setOpen(true)
        }}
      >
        {trigger}
      </Slot.Root>
      <Root open={open} onOpenChange={setOpen}>
        <Content
          onCloseAutoFocus={(event: Event) => {
            // No dialog trigger to return to: the row, while it stands, unless the
            // delete confirmation that opened as this closed has focus.
            event.preventDefault()
            if (handedOff.current) handedOff.current = false
            else if (triggerRef.current?.isConnected) triggerRef.current.focus()
          }}
        >
          <Header>
            <Title>{formatPropertyName(key)}</Title>
            <Description>{t('propertiesView.editDescription')}</Description>
          </Header>
          {parts.isMobile ? body : <DialogBody>{body}</DialogBody>}
          <Footer>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('action.cancel')}
            </Button>
            <Button
              disabled={!canSave}
              onClick={() => {
                // `save` reports its own failure; never rejects.
                void save()
              }}
            >
              {t('action.save')}
            </Button>
          </Footer>
        </Content>
      </Root>
    </>
  )
}
