/**
 * EditSelectOptions -- Settings' "Edit options" on a user select definition
 * (#5841): one row per option, to add, remove, reorder and Save, and to rename
 * an option, which renames it in every value the space's blocks hold, Trash
 * included, in one op the toast can undo.
 */

import { Settings2 } from 'lucide-react'
import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import {
  notifyDefinitionWrite,
  renameSelectOption,
} from '@/components/properties/notify-definition-write'
import { SelectOptionsPopover } from '@/components/properties/PropertyRowEditor/SelectEditor'
import { parseSelectOptions } from '@/components/properties/PropertyRowEditor/shared'
import { Button } from '@/components/ui/button'
import { useSelectOptionsDraft } from '@/hooks/useSelectOptionsDraft'
import { unwrap } from '@/lib/app-error'
import type { PropertyDefinition } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { invalidatePropertyCaches } from '@/lib/property-caches'
import { reportIpcErrorWithReason } from '@/lib/report-ipc-error'

export interface EditSelectOptionsProps {
  definition: PropertyDefinition
  spaceId: string
  /** Read the list again after a write or its undo. */
  onChanged: () => void
}

export function EditSelectOptions({
  definition,
  spaceId,
  onChanged,
}: EditSelectOptionsProps): React.ReactElement {
  const { t } = useTranslation()
  const { key } = definition
  const saved = useMemo(() => parseSelectOptions(definition), [definition])

  const changed = (): void => {
    onChanged()
    invalidatePropertyCaches()
  }

  const state = useSelectOptionsDraft(saved, {
    save: async (next) => {
      try {
        const { op_refs } = unwrap(
          await commands.updatePropertyDefOptions(spaceId, key, JSON.stringify(next)),
        )
        notifyDefinitionWrite(t('propertiesView.optionsSaved'), op_refs, changed)
        changed()
        return true
      } catch (error) {
        reportIpcErrorWithReason('EditSelectOptions', 'property.errorUpdate', error, t, { key })
        return false
      }
    },
    rename: (from, to) => renameSelectOption(spaceId, key, from, to, changed),
  })

  return (
    <SelectOptionsPopover
      propKey={key}
      state={state}
      trigger={
        <Button
          variant="ghost"
          size="xs"
          className="max-sm:px-0!"
          aria-label={t('propertiesView.editOptionsTooltip')}
        >
          <Settings2 />
          {t('propertiesView.editOptions')}
        </Button>
      }
    />
  )
}
