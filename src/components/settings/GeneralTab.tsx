/**
 * GeneralTab — General settings panel.
 *
 * Composes the deadline-warning section with the desktop-only
 * Autostart and quick-capture-shortcut rows, plus
 * The spaces-onboarding reset. Each row owns its own state +
 * IPC; this wrapper is layout-only.
 */

import type React from 'react'

import { DeadlineWarningSection } from '@/components/agenda/DeadlineWarningSection'
import { AutostartRow } from '@/components/settings/AutostartRow'
import { DebugModeRow } from '@/components/settings/DebugModeRow'
import { QuickCaptureRow } from '@/components/settings/QuickCaptureRow'
import { ResetOnboardingRow } from '@/components/settings/ResetOnboardingRow'

export function GeneralTab(): React.ReactElement {
  return (
    <div className="space-y-6">
      <DeadlineWarningSection />
      <AutostartRow />
      <QuickCaptureRow />
      <DebugModeRow />
      <ResetOnboardingRow />
    </div>
  )
}
