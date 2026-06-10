/**
 * Onboarding-completion flag helpers (#754).
 *
 * The `agaric-onboarding-done` localStorage key marks that the first-run
 * `WelcomeModal` was dismissed. Reads/writes live here — outside the
 * lazy-loaded `WelcomeModal` chunk — so the App shell can decide whether
 * to mount the modal at all WITHOUT pulling the chunk over the wire on
 * every boot. Both helpers tolerate a missing/disabled `localStorage`
 * (private mode, sandboxed iframe).
 */

const STORAGE_KEY = 'agaric-onboarding-done'

/** True once the user has dismissed the first-run welcome modal. */
export function isOnboardingDone(): boolean {
  try {
    return !!localStorage.getItem(STORAGE_KEY)
  } catch {
    return false
  }
}

/** Persist the dismissal so the welcome modal never re-opens. */
export function markOnboardingDone(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'true')
  } catch {
    // localStorage may be unavailable in some environments
  }
}
