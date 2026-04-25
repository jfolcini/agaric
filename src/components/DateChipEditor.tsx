/**
 * DateChipEditor — inline date editor for agenda date chips (F-22).
 *
 * Renders inside a Popover with:
 *   - A text input that accepts natural language dates (via parseDate)
 *   - Quick option buttons: Today, Tomorrow, Next week, Clear
 *   - Calls setDueDate / setScheduledDate on selection
 *   - Shows a toast on success
 *   - Calls onSuccess so the parent can close the popover and refresh
 */

import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { announce } from '@/lib/announcer'
import { formatDate } from '@/lib/date-utils'
import { setDueDate, setScheduledDate } from '@/lib/tauri'
import { useDateInput } from '../hooks/useDateInput'

export type DateType = 'due' | 'scheduled'

export interface DateChipEditorProps {
  /** Block ID to update. */
  blockId: string
  /** Which date field to modify. */
  dateType: DateType
  /** Current date value (YYYY-MM-DD or null). */
  currentDate: string | null
  /** Called after a successful update — parent should close popover and refresh. */
  onSuccess?: () => void
}

export function DateChipEditor({
  blockId,
  dateType,
  currentDate: _currentDate,
  onSuccess,
}: DateChipEditorProps): React.ReactElement {
  const { t } = useTranslation()

  // Date input hook (M-29) — manages input state + NL preview
  const { dateInput, datePreview, handleChange } = useDateInput()

  const applyDate = useCallback(
    async (newDate: string | null) => {
      try {
        if (dateType === 'due') {
          await setDueDate(blockId, newDate)
        } else {
          await setScheduledDate(blockId, newDate)
        }
        toast.success(newDate ? t('dateChip.dateUpdated') : t('dateChip.dateCleared'))
        announce(newDate ? t('announce.dateUpdated', { date: newDate }) : t('announce.dateCleared'))
        onSuccess?.()
      } catch {
        toast.error(t('dateChip.updateFailed'))
        announce(t('announce.rescheduleFailed'))
      }
    },
    [blockId, dateType, onSuccess, t],
  )

  const handleQuickOption = useCallback(
    (option: 'today' | 'tomorrow' | 'nextWeek' | 'clear') => {
      if (option === 'clear') {
        applyDate(null)
        return
      }
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      if (option === 'today') {
        applyDate(formatDate(today))
      } else if (option === 'tomorrow') {
        const d = new Date(today)
        d.setDate(d.getDate() + 1)
        applyDate(formatDate(d))
      } else if (option === 'nextWeek') {
        const d = new Date(today)
        d.setDate(d.getDate() + 7)
        applyDate(formatDate(d))
      }
    },
    [applyDate],
  )

  return (
    <div className="space-y-2" data-testid="date-chip-editor">
      {/* Natural language text input */}
      <div>
        <Input
          type="text"
          className="text-sm"
          placeholder={t('dateChip.placeholder')}
          value={dateInput}
          onChange={handleChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && datePreview) {
              e.preventDefault()
              applyDate(datePreview)
            }
          }}
          aria-label={t('dateChip.inputLabel')}
          autoFocus
        />
        {dateInput && (
          <p className="mt-1 text-xs text-muted-foreground">
            {datePreview ? (
              <>
                {t('datePicker.parsed')} <strong>{datePreview}</strong> (
                {t('datePicker.pressEnter')})
              </>
            ) : (
              <span className="text-destructive">{t('property.dateParseError')}</span>
            )}
          </p>
        )}
      </div>

      {/* Quick option buttons */}
      <div className="flex flex-wrap gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleQuickOption('today')}
          data-testid="quick-today"
        >
          {t('dateChip.today')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleQuickOption('tomorrow')}
          data-testid="quick-tomorrow"
        >
          {t('dateChip.tomorrow')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleQuickOption('nextWeek')}
          data-testid="quick-next-week"
        >
          {t('dateChip.nextWeek')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleQuickOption('clear')}
          data-testid="quick-clear"
        >
          {t('dateChip.clear')}
        </Button>
      </div>
    </div>
  )
}
