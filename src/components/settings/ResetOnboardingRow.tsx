/**
 * ResetOnboardingRow — `t('settings.resetOnboarding.title')` row inside the
 * General settings tab.
 *
 * The Spaces onboarding banner inside `t('space.manage')` is dismissed
 * permanently the first time the user clicks `t('space.onboardingDismiss')`,
 * persisting a flag in localStorage. There was no in-app way to bring
 * the banner back; this row is that affordance. Click → clear the flag
 * → toast confirmation. Next open of `t('space.manage')` re-renders
 * the hint.
 *
 * Stays visible on every platform — the underlying banner ships in
 * the cross-platform dialog, so the reset switch is equally useful
 * on desktop, mobile, and browser-dev.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { notify } from '@/lib/notify'

import { resetOnboardingSeen } from '../SpaceManageDialog'

export function ResetOnboardingRow(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{t('settings.resetOnboarding.title')}</p>
          <p className="text-xs text-muted-foreground">
            {t('settings.resetOnboarding.description')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            resetOnboardingSeen()
            notify.success(t('settings.resetOnboarding.success'))
          }}
          data-testid="reset-onboarding-btn"
        >
          {t('settings.resetOnboarding.button')}
        </Button>
      </div>
    </div>
  )
}
