/**
 * DeadlineWarningSection -- configure deadline warning threshold.
 *
 * Reads/writes the warning days to localStorage independently.
 */

import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
import { PREFERENCES, usePreference } from '@/lib/preferences'

const DEADLINE_WARNING_MIN = 0
const DEADLINE_WARNING_MAX = 90

export function DeadlineWarningSection(): React.ReactElement {
  const { t } = useTranslation()
  // Key/parse/serialize sourced from PREFERENCES.deadlineWarningDays (#2466)
  // so this stays in lock-step with useDuePanelData's read of the same key —
  // previously the two independently duplicated the parse logic.
  const [days, setDays] = usePreference(PREFERENCES.deadlineWarningDays)
  // Silent clamping (typing 100 and getting 90 with no feedback) confuses
  // users. Set on change, not on blur: the controlled field shows the clamped
  // value as soon as the change lands, so a blur never sees what was typed.
  const [clamped, setClamped] = useState(false)

  const handleChange = useCallback(
    (value: number) => {
      // Treat a blank/invalid entry (e.g. mid-edit field clear → NaN) as
      // "no change" rather than silently coercing to 0, which would disable
      // the warning and discard the user's setting without feedback.
      if (!Number.isFinite(value)) {
        setClamped(false)
        return
      }
      const next = Math.max(DEADLINE_WARNING_MIN, Math.min(DEADLINE_WARNING_MAX, value))
      setClamped(next !== value)
      setDays(next)
    },
    [setDays],
  )

  const descriptionId = settingDescriptionId('deadline-warning-days')

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
          aria-describedby={
            clamped ? `${descriptionId} deadline-warning-days-clamped` : descriptionId
          }
          onChange={(e) => handleChange(Number.parseInt(e.target.value, 10))}
        />
        <span className="text-xs text-muted-foreground">{t('block.daysUnit')}</span>
      </div>
      {clamped ? (
        <output
          id="deadline-warning-days-clamped"
          className="mt-1 block text-xs text-muted-foreground"
        >
          {t('settings.valueClamped', { min: DEADLINE_WARNING_MIN, max: DEADLINE_WARNING_MAX })}
        </output>
      ) : null}
    </SettingRow>
  )
}
