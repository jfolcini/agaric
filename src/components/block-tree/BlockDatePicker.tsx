/**
 * BlockDatePicker — floating date picker overlay with text input + calendar.
 *
 * Renders a Radix Dialog with:
 *   - A text input that accepts natural language dates (today, +3d, Apr 15)
 *   - A Calendar widget for visual date selection
 *
 * Radix Dialog provides: focus trap, Escape-to-close, focus-restore-to-trigger,
 * scroll-lock, outside-click dismissal, and proper ARIA semantics.
 *
 * Extracted from BlockTree.tsx for file organization (F-22).
 * Refactored to Radix Dialog (UX-213) — removes the hand-rolled focus trap.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useWeekStart } from '../../hooks/useWeekStart'
import { parseDate } from '../../lib/parse-date'
import { Calendar } from '../ui/calendar'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'

export function BlockDatePicker({
  onSelect,
  onClose,
}: {
  onSelect: (day: Date | undefined) => void
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const { weekStartsOn } = useWeekStart()
  const [dateTextInput, setDateTextInput] = useState('')
  const [dateTextPreview, setDateTextPreview] = useState<string | null>(null)

  /** Convert a parsed YYYY-MM-DD string to a Date and call onSelect. */
  const handleDateSelected = useCallback(
    (dateStr: string) => {
      const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number]
      const date = new Date(y, m - 1, d)
      onSelect(date)
    },
    [onSelect],
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        aria-label={t('journal.datePickerLabel')}
        className="date-picker-popup max-w-[calc(100vw-2rem)] sm:max-w-md"
        data-testid="date-picker-popup"
        data-editor-portal=""
      >
        {/* Radix requires DialogTitle for accessibility — visually hidden since aria-label is used */}
        <DialogTitle className="sr-only">{t('journal.datePickerLabel')}</DialogTitle>
        <DialogDescription className="sr-only">{t('dateChip.placeholder')}</DialogDescription>
        <DialogBody>
          {/* `pr-7` reserves room for the Dialog's absolute top-right close
              button so it never overlaps the input. */}
          <div className="flex flex-col gap-1.5 pb-3 pr-7">
            <span aria-hidden className="text-xs font-medium text-muted-foreground">
              {t('journal.datePickerLabel')}
            </span>
            <Input
              type="text"
              // Tame the focus treatment: the default red `border-ring` + 3px
              // `ring-ring/50` doubles up into something that reads as an error
              // in the red theme (ring ≈ destructive). A soft border + a 2px
              // low-opacity ring keeps a clear focus cue without the alarm.
              className="w-full focus-visible:!border-ring/40 focus-visible:!ring-2 focus-visible:!ring-ring/30"
              placeholder={t('dateChip.placeholder')}
              value={dateTextInput}
              onChange={(e) => {
                setDateTextInput(e.target.value)
                const parsed = parseDate(e.target.value)
                setDateTextPreview(parsed)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dateTextPreview) {
                  e.preventDefault()
                  handleDateSelected(dateTextPreview)
                  setDateTextInput('')
                  setDateTextPreview(null)
                }
              }}
              aria-label={t('journal.typeDateLabel')}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- block date picker opens inside a Dialog; focus the natural-language date input on open so the user can type a date immediately
              autoFocus
            />
            {dateTextInput && (
              <p className="text-xs text-muted-foreground">
                {dateTextPreview ? (
                  <>
                    {t('datePicker.parsed')}{' '}
                    <strong className="text-foreground">{dateTextPreview}</strong> (
                    {t('datePicker.pressEnter')})
                  </>
                ) : (
                  <span className="text-destructive">{t('property.dateParseError')}</span>
                )}
              </p>
            )}
          </div>
          <div className="flex justify-center border-t border-border/60 pt-1">
            <Calendar
              mode="single"
              weekStartsOn={weekStartsOn}
              showOutsideDays
              onSelect={onSelect}
              className="p-0"
              classNames={{
                // Calmer "today" marker — the shared default fills the cell with
                // a pink accent + `ring-primary/50`, which clashes in the red
                // theme. Use a subtle inset ring + primary-tinted numeral.
                today: 'rounded-md font-semibold text-primary ring-1 ring-inset ring-primary/40',
              }}
            />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
