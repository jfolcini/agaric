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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { ScrollArea } from '../ui/scroll-area'

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
      >
        {/* Radix requires DialogTitle for accessibility — visually hidden since aria-label is used */}
        <DialogTitle className="sr-only">{t('journal.datePickerLabel')}</DialogTitle>
        <DialogDescription className="sr-only">{t('dateChip.placeholder')}</DialogDescription>
        <ScrollArea className="max-sm:max-h-[70vh]">
          <div className="pb-2">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                className="flex-1"
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
                autoFocus
              />
            </div>
            {dateTextInput && (
              <p className="mt-1 text-xs text-muted-foreground">
                {dateTextPreview ? (
                  <>
                    {t('datePicker.parsed')} <strong>{dateTextPreview}</strong> (
                    {t('datePicker.pressEnter')})
                  </>
                ) : (
                  <span className="text-destructive">{t('property.dateParseError')}</span>
                )}
              </p>
            )}
          </div>
          <Calendar mode="single" weekStartsOn={weekStartsOn} showOutsideDays onSelect={onSelect} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
