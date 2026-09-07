/**
 * useLanguage — the app's UI language preference (#4555).
 *
 * Same shape as the other DOM-applying preference hooks (`useTheme`,
 * `useFontSize`, `useMotionPreference`): `usePreference` owns persistence
 * and cross-window sync, and an effect applies the resolved value. Mounted
 * once in the app shell so the effect runs app-wide, and again by the
 * Appearance tab for its Select — both instances see the same stored value,
 * so a change made in one window switches the language in every window.
 *
 * The effect is guarded on the locale it last REQUESTED, so the common case
 * (the stored preference already matches the locale `src/main.tsx` resolved
 * and loaded before the first render) does no work at all. Guarding on
 * `i18n.language` instead would skip the second of two quick switches
 * (#4812): that value is one switch behind while a catalog chunk is in
 * flight, so picking Espanol and then English reads `'en'` and returns
 * early, and `setLocale('en')` never runs. `setLocale` owns the other half —
 * dropping the abandoned Spanish load when it finally settles.
 */

import { useEffect, useRef } from 'react'

import { i18n } from '@/lib/i18n'
import { type LanguagePreference, resolveLocale } from '@/lib/i18n/locales'
import { setLocale } from '@/lib/i18n/set-locale'
import { PREFERENCES, usePreference } from '@/lib/preferences'

export function useLanguage(): {
  /** The stored preference — `'system'` or an explicit locale. */
  language: LanguagePreference
  setLanguage: (preference: LanguagePreference) => void
} {
  const [language, setValue] = usePreference(PREFERENCES.language)
  const resolvedLocale = resolveLocale(language)
  const requestedLocale = useRef(i18n.language)

  useEffect(() => {
    if (requestedLocale.current === resolvedLocale) return
    requestedLocale.current = resolvedLocale
    void setLocale(resolvedLocale)
  }, [resolvedLocale])

  return { language, setLanguage: setValue }
}
