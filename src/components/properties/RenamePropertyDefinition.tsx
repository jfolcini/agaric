/**
 * RenamePropertyDefinition -- "Rename" on a user property definition (#5841).
 * `rename_property_key` moves the definition and every value the space's
 * blocks hold under the key, Trash included, in one op the toast can undo.
 * The dialog declines what the backend would refuse anyway: a key the space
 * already defines (a built-in included) or one the app keeps for itself.
 */

import { Pencil } from 'lucide-react'
import type React from 'react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { RenameDialog } from '@/components/dialogs/RenameDialog'
import { notifyDefinitionWrite } from '@/components/properties/notify-definition-write'
import { IconButton } from '@/components/ui/icon-button'
import { unwrap } from '@/lib/app-error'
import type { PropertyDefinition } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { NON_DELETABLE_PROPERTIES } from '@/lib/property-save-utils'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'

export interface RenamePropertyDefinitionProps {
  definition: PropertyDefinition
  spaceId: string
  /** The space's definitions, built-ins included: keys the rename cannot take. */
  definitions: readonly PropertyDefinition[]
  /** Read the list again after a rename or its undo. */
  onChanged: () => void
  className?: string
}

export function RenamePropertyDefinition({
  definition,
  spaceId,
  definitions,
  onChanged,
  className,
}: RenamePropertyDefinitionProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { key } = definition

  const changed = (): void => {
    onChanged()
    invalidatePropertyCaches()
  }

  const validate = (name: string): string | null => {
    if (INTERNAL_PROPERTY_KEYS.has(name) || NON_DELETABLE_PROPERTIES.has(name)) {
      return t('propertiesView.reservedKey', { key: name })
    }
    if (name !== key && definitions.some((d) => d.key === name)) {
      return t('propertiesView.duplicateKey')
    }
    return null
  }

  const rename = async (newKey: string): Promise<void> => {
    if (newKey === key) return
    try {
      const { op_refs } = unwrap(await commands.renamePropertyKey(spaceId, key, newKey))
      notifyDefinitionWrite(
        t('propertiesView.renamed', { from: key, to: newKey }),
        op_refs,
        changed,
      )
      changed()
    } catch (error) {
      // The reason names what is in the way, e.g. blocks already holding the new key.
      reportIpcErrorWithReason(
        'RenamePropertyDefinition',
        'propertiesView.renameFailed',
        error,
        t,
        {
          key,
          newKey,
        },
      )
    }
  }

  return (
    <>
      <IconButton
        ref={triggerRef}
        variant="ghost"
        size="icon-xs"
        tooltip={t('propertiesView.renameTooltip')}
        ariaLabel={t('propertiesView.renameLabel', { key })}
        className={className}
        onClick={() => setOpen(true)}
      >
        <Pencil />
      </IconButton>
      <RenameDialog
        open={open}
        onOpenChange={setOpen}
        currentName={key}
        title={t('propertiesView.renameTitle', { key })}
        description={t('propertiesView.renameDescription', { key })}
        placeholder={t('propertiesView.renameInputLabel')}
        ariaLabel={t('propertiesView.renameInputLabel')}
        validate={validate}
        onCloseAutoFocus={(event) => {
          // No dialog trigger to return to: the opener, while its row stands.
          event.preventDefault()
          if (triggerRef.current?.isConnected) triggerRef.current.focus()
        }}
        onConfirm={(newKey) => {
          // `rename` reports its own failure; never rejects.
          void rename(newKey)
        }}
      />
    </>
  )
}
