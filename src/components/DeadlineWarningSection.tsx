/**
 * DeadlineWarningSection -- configure deadline warning threshold.
 *
 * Reads/writes the warning days to localStorage independently.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'

export function DeadlineWarningSection(): React.ReactElement {
  const { t } = useTranslation()
  const [days, setDays] = useState(() => {
    try {
      const stored = localStorage.getItem('agaric:deadlineWarningDays')
      return stored ? Number.parseInt(stored, 10) : 0
    } catch {
      return 0
    }
  })

  const handleChange = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(90, value))
    setDays(clamped)
    try {
      localStorage.setItem('agaric:deadlineWarningDays', String(clamped))
    } catch {}
  }, [])

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t('propertiesView.deadlineWarning')}</h3>
      <p className="text-xs text-muted-foreground">{t('propertiesView.deadlineWarningDesc')}</p>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          className="h-7 w-20 text-sm"
          min={0}
          max={90}
          value={days}
          aria-label={t('propertiesView.deadlineWarning')}
          onChange={(e) => handleChange(Number.parseInt(e.target.value, 10) || 0)}
        />
        <span className="text-xs text-muted-foreground">{t('block.daysDisabledHint')}</span>
      </div>
    </div>
  )
}
