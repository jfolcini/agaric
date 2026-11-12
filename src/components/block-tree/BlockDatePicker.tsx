/**
 * BlockDatePicker — floating date picker overlay with text input + calendar.
 *
 * Renders a Radix Dialog with:
 *   - A text input that accepts natural language dates (today, +3d, Apr 15)
 *   - A Calendar widget for visual date selection
 *   - Opened on a date the block has: that date selected and in view, and a
 *     "Clear date" button that removes it
 *
 * Radix Dialog provides: focus trap, Escape-to-close, focus-restore-to-trigger,
 * scroll-lock, outside-click dismissal, and proper ARIA semantics.
 *
 * Extracted from BlockTree.tsx for file organization (F-22).
 * Refactored to Radix Dialog — removes the hand-rolled focus trap.
 * On a phone it is a bottom sheet (`useDialogOrSheet`), in thumb reach.
 */

import { parseISO } from 'date-fns'
import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DatePickerMode } from '@/components/block-tree/use-block-date-picker'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { DialogBody } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SheetBody } from '@/components/ui/sheet'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import { useWeekStart } from '@/hooks/useWeekStart'
import { parseDate } from '@/lib/parse-date'

const TITLE_KEYS: Partial<Record<DatePickerMode, string>> = {
  due: 'datePicker.dueTitle',
  schedule: 'datePicker.scheduledTitle',
}

export function BlockDatePicker({
  mode,
  value = null,
  onSelect,
  onClose,
  onClear,
}: {
  /** Which date the picker edits; a due or scheduled date names the title. */
  mode?: DatePickerMode
  /** The edited date the block already has (YYYY-MM-DD): selected, in view, and clearable. */
  value?: string | null
  onSelect: (day: Date | undefined) => void
  onClose: () => void
  /** Removes `value`; offered only while there is one. */
  onClear?: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const title = t(TITLE_KEYS[mode ?? 'date'] ?? 'journal.datePickerLabel')
  const selected = value === null ? undefined : parseISO(value)
  const parts = useDialogOrSheet('dialog')
  const { Root, Content, Header, Title, Description } = parts
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

  const body = (
    <>
      <div className="flex flex-col gap-1.5 pb-3">
        <Input
          type="text"
          className="w-full"
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
          // Picking the selected day again keeps it rather than deselecting it.
          required
          selected={selected}
          {...(selected !== undefined && { defaultMonth: selected })}
          weekStartsOn={weekStartsOn}
          showOutsideDays
          onSelect={onSelect}
          className="p-0"
          classNames={{
            // Calmer "today" marker than the shared accent fill.
            today: 'rounded-md font-semibold text-brand ring-1 ring-inset ring-brand/40',
          }}
        />
      </div>
      {selected !== undefined && onClear !== undefined && (
        <div className="flex justify-end border-t border-border/60 pt-2">
          <Button variant="ghost" size="sm" onClick={onClear}>
            {t('datePicker.clearDate')}
          </Button>
        </div>
      )}
    </>
  )

  return (
    <Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Content
        aria-label={title}
        // As wide as the calendar plus the dialog's padding; touch cells are
        // larger, so a coarse pointer gets the next width up.
        className={
          parts.isMobile
            ? 'date-picker-popup'
            : 'date-picker-popup max-w-[calc(100vw-2rem)] sm:max-w-xs [@media(pointer:coarse)]:sm:max-w-sm'
        }
        data-testid="date-picker-popup"
        data-editor-portal=""
      >
        <Header>
          <Title>{title}</Title>
          <Description className="sr-only">{t('dateChip.placeholder')}</Description>
        </Header>
        {/* The calendar can outgrow a sheet lifted above the soft keyboard,
            so the body scrolls there too. */}
        {parts.isMobile ? <SheetBody>{body}</SheetBody> : <DialogBody>{body}</DialogBody>}
      </Content>
    </Root>
  )
}
