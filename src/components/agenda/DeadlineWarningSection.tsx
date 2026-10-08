/**
 * DeadlineWarningSection -- configure deadline warning threshold.
 *
 * Reads/writes the warning days to localStorage independently.
 */

import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
import { notify } from '@/lib/notify'
import { PREFERENCES, usePreference } from '@/lib/preferences'

const DEADLINE_WARNING_MIN = 0
const DEADLINE_WARNING_MAX = 90

export function DeadlineWarningSection(): React.ReactElement {
  const { t } = useTranslation()
  // Key/parse/serialize sourced from PREFERENCES.deadlineWarningDays (#2466)
  // so this stays in lock-step with useDuePanelData's read of the same key —
  // previously the two independently duplicated the parse logic.
  const [days, setDays] = usePreference(PREFERENCES.deadlineWarningDays)

  const handleChange = useCallback(
    (value: number) => {
      // Treat a blank/invalid entry (e.g. mid-edit field clear → NaN) as
      // "no change" rather than silently coercing to 0, which would disable
      // the warning and discard the user's setting without feedback.
      if (!Number.isFinite(value)) return
      const clamped = Math.max(DEADLINE_WARNING_MIN, Math.min(DEADLINE_WARNING_MAX, value))
      setDays(clamped)
    },
    [setDays],
  )

  // Notify the user when their typed value was clamped — silent clamping
  // (e.g. typing 100 and getting 90 with no feedback) is a documented
  // anti-pattern and confuses users.
  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      const raw = Number.parseInt(e.target.value, 10)
      if (!Number.isFinite(raw)) return
      if (raw < DEADLINE_WARNING_MIN || raw > DEADLINE_WARNING_MAX) {
        notify.info(
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
    <SettingRow
      label={t('propertiesView.deadlineWarning')}
      description={t('propertiesView.deadlineWarningDesc')}
      controlId="deadline-warning-days"
    >
      <div className="flex items-center gap-2">
        <Input
          id="deadline-warning-days"
          type="number"
          className="h-7 w-20 text-sm"
          min={DEADLINE_WARNING_MIN}
          max={DEADLINE_WARNING_MAX}
          value={days}
          aria-describedby={settingDescriptionId('deadline-warning-days')}
          onChange={(e) => handleChange(Number.parseInt(e.target.value, 10))}
          onBlur={handleBlur}
        />
        <span className="text-xs text-muted-foreground">{t('block.daysUnit')}</span>
      </div>
    </SettingRow>
  )
}
