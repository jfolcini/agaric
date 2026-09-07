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
 * The effect is guarded on `i18n.language`, so the common case (the stored
 * preference already matches the locale `src/main.tsx` resolved and loaded
 * before the first render) does no work at all.
 *
 * There is no in-flight/disabled state, and the guard above is on
 * `i18n.language` — which is one switch BEHIND while a chunk is loading.
 * KNOWN GAP (#4812): pick Espanol, then English before `import('@/lib/i18n/es')`
 * settles, and this effect reads `i18n.language === 'en'` — still true, the
 * switch has not landed — and returns, so `setLocale('en')` never runs; the
 * Spanish load then resolves and leaves a Spanish UI under a Select reading
 * "English", with nothing to re-fire the effect. Closing it takes two guards
 * (this one on the REQUESTED locale, and a supersede check inside `setLocale`,
 * because `en` is bundled while `es` is a chunk, so the stale load reliably
 * resolves last), and neither is reachable from the vitest harness: the
 * already-cached chunk settles inside the same `act`, so a test written here
 * passes with or without the fix. It is filed rather than guessed at.
 */

import { useEffect } from 'react'

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

  useEffect(() => {
    if (i18n.language === resolvedLocale) return
    void setLocale(resolvedLocale)
  }, [resolvedLocale])

  return { language, setLanguage: setValue }
}
