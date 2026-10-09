/**
 * ShowWelcomeTourRow — `t('settings.showWelcomeTour.title')` row inside the
 * General settings tab.
 *
 * The first-run `WelcomeModal` is dismissed permanently the first time the
 * user closes it (any close path — "Get Started", clicking outside, Escape,
 * the Android hardware Back button), persisting `agaric-onboarding-done`.
 * Before #3308 nothing in the product could bring it back, which also made
 * "Create sample pages" — its only call site — unreachable forever. This row
 * is that affordance: click → clear the flag → the modal re-opens
 * immediately (via `SHOW_WELCOME_EVENT`, see `@/lib/onboarding`) → toast
 * confirmation.
 *
 * Stays visible on every platform — the welcome modal ships in the
 * cross-platform dialog/sheet, so the reset is equally useful on desktop,
 * mobile, and browser-dev.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { SettingRow } from '@/components/ui/setting-row'
import { notify } from '@/lib/notify'
import { resetOnboarding } from '@/lib/onboarding'

export function ShowWelcomeTourRow(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <SettingRow
      label={t('settings.showWelcomeTour.title')}
      description={t('settings.showWelcomeTour.description')}
    >
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          resetOnboarding()
          notify.success(t('settings.showWelcomeTour.success'))
        }}
        data-testid="show-welcome-tour-btn"
      >
        {t('settings.showWelcomeTour.button')}
      </Button>
    </SettingRow>
  )
}
