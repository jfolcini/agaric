/**
 * SettingsForm — window-days + privacy-mode form fields for the
 * Google Calendar settings tab.
 *
 * Extracted from `GoogleCalendarSettingsTab.tsx` per Phase 3b of
 * `pending/design-system-maintainability-2026-05-09.md`.
 *
 * Pure presentational: the parent owns the debounced IPC dispatch
 * (`set_gcal_window_days`, `set_gcal_privacy_mode`) and the optimistic
 * input mirror; this component just wires the `<Input>` + `<Switch>`
 * pair to the callbacks and consumes the canonical bounds via props
 * so the orchestrator remains the single source of truth for
 * `WINDOW_MIN` / `WINDOW_MAX`.
 *
 * All field IDs, data-test IDs and aria labels match the pre-split
 * implementation byte-for-byte so the existing
 * `GoogleCalendarSettingsTab.test.tsx` suite continues to pass.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export interface SettingsFormProps {
  /** Whether the GCal account is currently connected (gates inputs). */
  connected: boolean
  /** Controlled input value — string so the user can type freely. */
  windowInput: string
  /** Numeric bound: minimum window size (inclusive). */
  windowMin: number
  /** Numeric bound: maximum window size (inclusive). */
  windowMax: number
  /** Current privacy mode from `GcalStatus` (`'full' | 'minimal'`; typed
   *  as `string` upstream in `bindings.ts` because the Tauri binding
   *  doesn't narrow the union — the `checked` derivation below treats
   *  anything other than the literal `'minimal'` as `full`). */
  privacyMode: string
  /** Forwarded to the window-days input. */
  onWindowChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  /** Forwarded to the window-days input. */
  onWindowBlur: () => void
  /** Called with the next checked state of the Switch. */
  onPrivacyToggle: (nextMinimal: boolean) => void
}

export function SettingsForm({
  connected,
  windowInput,
  windowMin,
  windowMax,
  privacyMode,
  onWindowChange,
  onWindowBlur,
  onPrivacyToggle,
}: SettingsFormProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <>
      {/* Window size */}
      <div className="space-y-2">
        <Label htmlFor="gcal-window-days" muted={false}>
          {t('gcal.windowLabel')}
        </Label>
        <Input
          id="gcal-window-days"
          type="number"
          min={windowMin}
          max={windowMax}
          step={1}
          value={windowInput}
          onChange={onWindowChange}
          onBlur={onWindowBlur}
          aria-label={t('gcal.windowLabel')}
          className="max-w-[8rem]"
          disabled={!connected}
          data-testid="gcal-window-input"
        />
        <p className="text-xs text-muted-foreground">{t('gcal.windowHelp')}</p>
      </div>

      {/* Privacy mode */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label htmlFor="gcal-privacy-toggle" muted={false}>
            {t('gcal.privacyLabel')}
          </Label>
          <p className="text-xs text-muted-foreground mt-1">{t('gcal.privacyHelp')}</p>
        </div>
        <Switch
          id="gcal-privacy-toggle"
          checked={privacyMode === 'minimal'}
          onCheckedChange={onPrivacyToggle}
          aria-label={t('gcal.privacyLabel')}
          disabled={!connected}
        />
      </div>
    </>
  )
}
