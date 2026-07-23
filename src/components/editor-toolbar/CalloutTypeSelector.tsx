/**
 * CalloutTypeSelector — inline, searchable picker for choosing a callout variant
 * (#215, single-step rework #3001).
 *
 * The toolbar Callout button previously inserted only the `info` variant; the
 * other four (warning / tip / error / note) were slash-only. This picker surfaces
 * all five (icon + label). Before #3001 it was a plain menu reached only AFTER the
 * block was already a callout (turn-into default → reopen → pick), a two-step flow.
 * It now mirrors the code-language picker: a filter input (typeahead) plus a
 * keyboard-navigable list, so type + variant are chosen in ONE interaction, by
 * mouse or keyboard.
 *
 * Selecting a variant dispatches `INSERT_CALLOUT` with the chosen `type` in the
 * event detail — `useBlockTreeEventListeners` applies `> [!TYPE]` to the focused
 * block, converting a plain paragraph (or re-typing an existing callout) in a
 * single command. Apply semantics are unchanged from the previous menu.
 */

import { matchSorter } from 'match-sorter'
import type React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  PickerFilterInput,
  PickerRow,
  useInlinePickerKeyboard,
} from '@/components/editor-toolbar/InlinePicker'
import { CALLOUT_CONFIG } from '@/components/RichContentRenderer/context'
import { dispatchBlockEvent } from '@/lib/block-events'

const CALLOUT_TYPES = ['info', 'warning', 'tip', 'error', 'note'] as const

export interface CalloutTypeSelectorProps {
  onClose: () => void
}

export function CalloutTypeSelector({ onClose }: CalloutTypeSelectorProps): React.ReactElement {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')

  const items = useMemo(
    () =>
      CALLOUT_TYPES.map((type) => ({
        type,
        label: t(`callout.${type}`),
        icon: CALLOUT_CONFIG[type]?.icon,
      })),
    [t],
  )

  // Filter by both the translated label ("Warning") and the raw token
  // ("warning") so typeahead works regardless of the active locale.
  const filtered = useMemo(
    () => (filter ? matchSorter(items, filter, { keys: ['label', 'type'] }) : items),
    [filter, items],
  )

  function applyType(type: string): void {
    dispatchBlockEvent('INSERT_CALLOUT', { type })
    onClose()
  }

  const { focusedIndex, handleFilterKeyDown } = useInlinePickerKeyboard({
    itemCount: filtered.length,
    onSelect: (idx) => {
      const item = filtered[idx]
      if (item) applyType(item.type)
    },
    onClose,
  })

  return (
    <div className="flex flex-col gap-0.5">
      <PickerFilterInput
        value={filter}
        onChange={setFilter}
        ariaLabel={t('toolbar.callout')}
        onKeyDown={handleFilterKeyDown}
      />
      {filtered.map((item, idx) => (
        <PickerRow
          key={item.type}
          icon={item.icon}
          label={item.label}
          focused={idx === focusedIndex}
          testId={`callout-type-${item.type}`}
          onSelect={() => applyType(item.type)}
        />
      ))}
    </div>
  )
}
