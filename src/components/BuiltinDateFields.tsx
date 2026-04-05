/**
 * BuiltinDateFields — read-only date field display for built-in
 * block dates (due_date, scheduled_date).
 *
 * Extracted from BlockPropertyDrawer. Shows each date as a PropertyRow
 * with an editable date input and a clear button. Only used by
 * BlockPropertyDrawer (page properties don't have built-in dates).
 */

import { CalendarCheck2, CalendarClock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PropertyRow } from './BlockPropertyDrawer'

export interface BuiltinDateFieldsProps {
  dueDate: string | null
  scheduledDate: string | null
  hasCustomProperties: boolean
  onSaveDate: (field: 'due_date' | 'scheduled_date', value: string) => void
  onClearDate: (field: 'due_date' | 'scheduled_date') => void
}

export function BuiltinDateFields({
  dueDate,
  scheduledDate,
  hasCustomProperties,
  onSaveDate,
  onClearDate,
}: BuiltinDateFieldsProps) {
  const { t } = useTranslation()

  const hasBuiltinDates = dueDate !== null || scheduledDate !== null

  if (!hasBuiltinDates) return null

  return (
    <>
      {dueDate !== null && (
        <PropertyRow
          key={`due-${dueDate}`}
          icon={CalendarCheck2}
          label={t('property.dueDate')}
          value={dueDate}
          inputType="date"
          ariaLabel={t('property.valueLabel', {
            key: t('property.dueDate'),
          })}
          onSave={(v) => onSaveDate('due_date', v)}
          onRemove={() => onClearDate('due_date')}
          removeAriaLabel={t('property.clearDueDate')}
        />
      )}
      {scheduledDate !== null && (
        <PropertyRow
          key={`sched-${scheduledDate}`}
          icon={CalendarClock}
          label={t('property.scheduledDate')}
          value={scheduledDate}
          inputType="date"
          ariaLabel={t('property.valueLabel', {
            key: t('property.scheduledDate'),
          })}
          onSave={(v) => onSaveDate('scheduled_date', v)}
          onRemove={() => onClearDate('scheduled_date')}
          removeAriaLabel={t('property.clearScheduledDate')}
        />
      )}
      {hasCustomProperties && <div className="border-t border-border/40" />}
    </>
  )
}
