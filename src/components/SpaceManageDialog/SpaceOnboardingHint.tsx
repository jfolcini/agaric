/**
 * SpaceOnboardingHint — first-open onboarding banner for the manage-spaces
 * Dialog. Lifted out of the per-row `SpaceRowEditor` (D-2) so it
 * renders exactly once at the dialog level rather than once per row.
 *
 * **localStorage key.** Pre- the dismissal flag was keyed by
 * `i18n.t('space.onboardingSeenKey')` — i.e. derived from the runtime
 * i18n bundle. That was a smell: the storage key is invariant across
 * locales (a per-locale key would orphan the flag on language switch),
 * and re-resolving it at runtime added a translation lookup to every
 * read/write. The key value is now a stable module-level constant; the
 * **string value is preserved verbatim** (`agaric:space-onboarding-seen-v1`)
 * so existing users do not see the banner again after upgrade.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'

const LOG_MODULE = 'components/SpaceManageDialog/SpaceOnboardingHint'

/**
 * Storage key for the onboarding-seen flag. **Do not change the value**
 * — pre-existing users have this key set in their localStorage and
 * changing the string would re-show the banner once after upgrade.
 *
 * Pre- this was derived at runtime from the i18n bundle key
 * `space.onboardingSeenKey`. The new const matches the previously-seeded
 * value `agaric:space-onboarding-seen-v1` exactly.
 */
export const ONBOARDING_STORAGE_KEY = 'agaric:space-onboarding-seen-v1'

/**
 * Read the dismissal flag for the onboarding hint. Returns `false`
 * when `localStorage` access throws (Private Browsing on iOS) so the
 * hint at worst shows once per session.
 */
export function readOnboardingSeen(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeOnboardingSeen(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true')
  } catch (err) {
    logger.warn(LOG_MODULE, 'failed to persist onboarding-dismissed flag', undefined, err)
  }
}

/**
 * Clear the onboarding-dismissed flag so the banner shows again on
 * the next `Manage spaces` open. Surfaced from Settings → General as
 * The in-app way to undo a `Got it` dismissal.
 */
export function resetOnboardingSeen(): void {
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY)
  } catch (err) {
    logger.warn(LOG_MODULE, 'failed to reset onboarding-dismissed flag', undefined, err)
  }
}

interface SpaceOnboardingHintProps {
  /**
   * `true` when the dialog is open. The hint is only evaluated while
   * the dialog is open so dismissal during the session is reflected
   * immediately on the next open without holding state when the
   * dialog is closed.
   */
  open: boolean
  /**
   * Number of available spaces. The hint only shows when ≤2 spaces
   * exist (the seeded `Personal` + `Work` baseline).
   */
  availableSpaceCount: number
}

/**
 * Inline banner shown the first time a user opens the manage-spaces
 * dialog with the seeded ≤2-space layout. Dismissal persists to
 * localStorage and unmounts the banner immediately.
 *
 * Renders nothing when the dismissal flag is set, when more than 2
 * spaces exist, or when the dialog is closed.
 */
export function SpaceOnboardingHint({
  open,
  availableSpaceCount,
}: SpaceOnboardingHintProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)

  // Re-evaluate visibility on each open — dismissal in the same session
  // is reflected without a remount, and a freshly-set flag (e.g. via
  // `resetOnboardingSeen` from Settings) is observed on the next open.
  useEffect(() => {
    if (!open) return
    setVisible(availableSpaceCount <= 2 && !readOnboardingSeen())
  }, [open, availableSpaceCount])

  const handleDismiss = useCallback(() => {
    writeOnboardingSeen()
    setVisible(false)
  }, [])

  if (!visible) return null

  return (
    <div
      role="note"
      aria-label={t('space.onboardingTitle')}
      className="rounded-md border bg-muted/40 p-3 text-sm"
    >
      <p className="font-medium">{t('space.onboardingTitle')}</p>
      <p className="mt-1 text-muted-foreground">{t('space.onboardingBody')}</p>
      <div className="mt-2 flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={handleDismiss}>
          {t('space.onboardingDismiss')}
        </Button>
      </div>
    </div>
  )
}
