/**
 * CalloutTypeSelector — the toolbar's inline list of callout variants (#215,
 * single-step #3001), expanded in place under Turn into → Callout.
 *
 * A short fixed list, so no filter box: the code-language picker filters because
 * its list is long. Selecting a variant dispatches
 * `INSERT_CALLOUT` with the chosen `type`; `useBlockTreeEventListeners` applies
 * `> [!TYPE]` to the focused block, converting a paragraph or re-typing a callout.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { PickerRow } from '@/components/editor-toolbar/InlinePicker'
import { CALLOUT_CONFIG, CALLOUT_TYPES } from '@/components/RichContentRenderer/context'
import { dispatchBlockCommand } from '@/stores/block-command-bus'

export interface CalloutTypeSelectorProps {
  onClose: () => void
}

export function CalloutTypeSelector({ onClose }: CalloutTypeSelectorProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-0.5">
      {CALLOUT_TYPES.map((type) => (
        <PickerRow
          key={type}
          icon={CALLOUT_CONFIG[type]?.icon}
          label={t(`callout.${type}`)}
          testId={`callout-type-${type}`}
          onSelect={() => {
            dispatchBlockCommand('INSERT_CALLOUT', { type })
            onClose()
          }}
        />
      ))}
    </div>
  )
}
