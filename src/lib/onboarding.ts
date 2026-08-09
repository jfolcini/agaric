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

import { PREFERENCES, readPreference, removePreference, writePreference } from '@/lib/preferences'

/**
 * Global "show the welcome tour again" DOM event (#3308 finding 1).
 *
 * Dispatched on `window` by {@link resetOnboarding} so the App shell — which
 * gate-mounts the lazy `WelcomeModal` from a `useState` read of the
 * onboarding flag — learns that the flag was cleared and can re-mount the
 * modal. Settings and the App shell sit far apart in the tree with no shared
 * owner, and this is a one-shot signal with no state of its own, so it
 * follows the same plain-`CustomEvent`-on-`window` convention as
 * `CLOSE_ALL_OVERLAYS_EVENT` / `SHOW_SHORTCUTS_EVENT`
 * (`src/lib/overlay-events.ts`) rather than introducing a store.
 *
 * It lives HERE rather than in `overlay-events.ts` because the signal is
 * owned by the onboarding flag itself: every emitter goes through
 * `resetOnboarding`, and every consumer already imports this module.
 */
export const SHOW_WELCOME_EVENT = 'agaric:showWelcome'

/** True once the user has dismissed the first-run welcome modal. */
export function isOnboardingDone(): boolean {
  return readPreference(PREFERENCES.onboardingDone)
}

/** Persist the dismissal so the welcome modal never re-opens. */
export function markOnboardingDone(): void {
  writePreference(PREFERENCES.onboardingDone, true)
}

/**
 * Clear the dismissal so the welcome modal shows again, and signal every
 * live listener (the App shell's welcome gate) to re-mount it now — the
 * user asked for the tour, so waiting for the next launch is not the
 * product behaviour.
 *
 * REMOVES the key rather than writing `false`: `PREFERENCES.onboardingDone`
 * uses the legacy presence-means-done format (`parse: () => true`,
 * `serialize: () => 'true'`), so `writePreference(..., false)` would still
 * persist the string `'true'` and leave onboarding done. This mirrors
 * `resetOnboardingSeen` (the spaces-hint reset), which clears its flag the
 * same way — see `preferences.ts`, "removePreference".
 */
export function resetOnboarding(): void {
  removePreference(PREFERENCES.onboardingDone)
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SHOW_WELCOME_EVENT))
}
