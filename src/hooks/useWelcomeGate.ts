/**
 * `useWelcomeGate` — the App shell's first-run gate for the lazy
 * `WelcomeModal`, plus the re-entry path (#3308 finding 1).
 *
 * The flag is read ONCE per session (the `useState` lazy initializer) so a
 * user who has finished onboarding never mounts the modal — and therefore
 * never fetches its chunk — on boot (#754). What changed: the gate is now
 * *state*, and `resetOnboarding()` (Settings → General → "Show the welcome
 * tour again") flips it back on via the `SHOW_WELCOME_EVENT` window event.
 *
 * `remountKey` exists because `WelcomeModal` derives its `open` state from
 * its own `useState(() => !isOnboardingDone())` initializer. Once the modal
 * has been dismissed in-session it stays mounted with `open === false`, so
 * merely setting `show` back to `true` would change nothing. Feeding
 * `remountKey` to the modal's `key` prop forces a fresh mount whose
 * initializer re-reads the (now cleared) flag and opens.
 */

import { useEffect, useState } from 'react'

import { isOnboardingDone, SHOW_WELCOME_EVENT } from '@/lib/onboarding'

export interface WelcomeGate {
  /** Whether the App shell should mount `WelcomeModal` at all. */
  show: boolean
  /** Pass as the modal's `key` — bumping it remounts (and so re-opens) it. */
  remountKey: number
}

export function useWelcomeGate(): WelcomeGate {
  const [show, setShow] = useState(() => !isOnboardingDone())
  const [remountKey, setRemountKey] = useState(0)

  useEffect(() => {
    function handleShowWelcome(): void {
      setShow(true)
      setRemountKey((key) => key + 1)
    }
    window.addEventListener(SHOW_WELCOME_EVENT, handleShowWelcome)
    return () => window.removeEventListener(SHOW_WELCOME_EVENT, handleShowWelcome)
  }, [])

  return { show, remountKey }
}
