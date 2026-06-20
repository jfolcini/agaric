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

import { AutostartRow } from './AutostartRow'
import { QuickCaptureRow } from './QuickCaptureRow'
import { ResetOnboardingRow } from './ResetOnboardingRow'

export function GeneralTab(): React.ReactElement {
  return (
    <div className="space-y-6">
      <DeadlineWarningSection />
      <AutostartRow />
      <QuickCaptureRow />
      <ResetOnboardingRow />
    </div>
  )
}
