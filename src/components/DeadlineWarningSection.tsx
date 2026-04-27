/**
 * DeadlineWarningSection -- configure deadline warning threshold.
 *
 * Reads/writes the warning days to localStorage independently.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { logger } from '@/lib/logger'

const DEADLINE_WARNING_MIN = 0
const DEADLINE_WARNING_MAX = 90

export function DeadlineWarningSection(): React.ReactElement {
  const { t } = useTranslation()
  const [days, setDays] = useState(() => {
    try {
      const stored = localStorage.getItem('agaric:deadlineWarningDays')
      return stored ? Number.parseInt(stored, 10) : 0
    } catch (err) {
      logger.warn(
        'DeadlineWarningSection',
        'failed to read deadlineWarningDays from localStorage',
        {},
        err,
      )
      return 0
    }
  })

  const handleChange = useCallback((value: number) => {
    const clamped = Math.max(DEADLINE_WARNING_MIN, Math.min(DEADLINE_WARNING_MAX, value))
    setDays(clamped)
    try {
      localStorage.setItem('agaric:deadlineWarningDays', String(clamped))
    } catch (err) {
      logger.warn(
        'DeadlineWarningSection',
        'failed to persist deadlineWarningDays to localStorage',
        { clamped },
        err,
      )
    }
  }, [])

  // UX-4: notify the user when their typed value was clamped — silent clamping
  // (e.g. typing 100 and getting 90 with no feedback) is a documented
  // anti-pattern and confuses users.
  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      const raw = Number.parseInt(e.target.value, 10)
      if (!Number.isFinite(raw)) return
      if (raw < DEADLINE_WARNING_MIN || raw > DEADLINE_WARNING_MAX) {
        toast.info(
          t('settings.valueClamped', {
            min: DEADLINE_WARNING_MIN,
            max: DEADLINE_WARNING_MAX,
          }),
        )
      }
    },
    [t],
  )

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t('propertiesView.deadlineWarning')}</h3>
      <p className="text-xs text-muted-foreground">{t('propertiesView.deadlineWarningDesc')}</p>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="h-7 w-20 text-sm"
          min={DEADLINE_WARNING_MIN}
          max={DEADLINE_WARNING_MAX}
          value={days}
          aria-label={t('propertiesView.deadlineWarning')}
          onChange={(e) => handleChange(Number.parseInt(e.target.value, 10) || 0)}
          onBlur={handleBlur}
        />
        <span className="text-xs text-muted-foreground">{t('block.daysDisabledHint')}</span>
      </div>
    </div>
  )
}
