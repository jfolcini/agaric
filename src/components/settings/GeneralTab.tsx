/**
 * GeneralTab — General settings panel.
 *
 * Composes the deadline-warning section (UX-202) with the desktop-only
 * autostart (FEAT-13) and quick-capture-shortcut (FEAT-12) rows, plus
 * the spaces-onboarding reset (UX-374). Each row owns its own state +
 * IPC; this wrapper is layout-only.
 */

import type React from 'react'
import { DeadlineWarningSection } from '../DeadlineWarningSection'
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
