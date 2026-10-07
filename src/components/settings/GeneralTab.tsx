/**
 * GeneralTab — General settings panel.
 *
 * Composes the deadline-warning section with the desktop-only
 * Autostart and quick-capture-shortcut rows, plus the spaces-onboarding
 * reset and the welcome-tour re-entry (#3308). Each row owns its own
 * state + IPC; this wrapper is layout-only.
 */

import type React from 'react'

import { DeadlineWarningSection } from '@/components/agenda/DeadlineWarningSection'
import { AutostartRow } from '@/components/settings/AutostartRow'
import { DebugModeRow } from '@/components/settings/DebugModeRow'
import { QuickCaptureRow } from '@/components/settings/QuickCaptureRow'
import { ResetOnboardingRow } from '@/components/settings/ResetOnboardingRow'
import { ShowWelcomeTourRow } from '@/components/settings/ShowWelcomeTourRow'
import { Card, CardContent } from '@/components/ui/card'

export function GeneralTab(): React.ReactElement {
  return (
    <Card>
      <CardContent className="space-y-6">
        <DeadlineWarningSection />
        <AutostartRow />
        <QuickCaptureRow />
        <DebugModeRow />
        <ResetOnboardingRow />
        <ShowWelcomeTourRow />
      </CardContent>
    </Card>
  )
}
