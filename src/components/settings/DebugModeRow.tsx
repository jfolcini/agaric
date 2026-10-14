/**
 * DebugModeRow — `t('settings.debugMode.label')` toggle inside the
 * General settings tab (#1987).
 *
 * Flips the app-wide `PREFERENCES.debugMode` flag. When on, error toasts
 * and inline banners append the raw error `kind`/code via
 * `formatErrorForDisplay`. Purely local state (a localStorage preference) —
 * no IPC, so no optimistic-revert dance.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { ToggleRow } from '@/components/ui/toggle-row'
import { PREFERENCES, usePreference } from '@/lib/preferences'

export function DebugModeRow(): React.ReactElement {
  const { t } = useTranslation()
  const [debugMode, setDebugMode] = usePreference(PREFERENCES.debugMode)

  return (
    <ToggleRow
      id="debug-mode-toggle"
      label={t('settings.debugMode.label')}
      description={t('settings.debugMode.description')}
      checked={debugMode}
      onCheckedChange={setDebugMode}
      data-testid="debug-mode-toggle"
    />
  )
}
