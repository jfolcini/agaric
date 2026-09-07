/**
 * Locale registry — everything that is per-locale DATA: which languages
 * exist, how the stored language preference resolves to one of them, and
 * each one's `date-fns` `Locale` (#4555).
 *
 * Deliberately a leaf: it imports no other app module. Three modules need
 * it — `src/lib/preferences.ts` to validate the stored `agaric-language`
 * value, `src/lib/i18n/index.ts` to pick the boot language, and
 * `src/lib/date-locale.ts` to resolve dates — and a lazily-loaded catalog
 * chunk registers its own `date-fns` locale into it. Anything less than a
 * leaf makes that last edge an import cycle.
 *
 * English is the only statically-bundled catalog: it is i18next's
 * `fallbackLng`, and a fallback that has to be fetched is a fallback that
 * can fail. Every other locale is a dynamic `import()` resolved by
 * `loadLocale()` in `./index.ts`.
 */

import type { Locale } from 'date-fns'
import { enUS } from 'date-fns/locale'

/** Every locale the app can render in. `en` is bundled; the rest are lazy. */
export const SUPPORTED_LOCALES = ['en', 'es'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/** The statically-bundled locale, and i18next's `fallbackLng`. */
export const DEFAULT_LOCALE = 'en' satisfies SupportedLocale

/**
 * The stored preference: a concrete locale, or `'system'` to follow the
 * device. `'system'` is the default, so a Spanish-OS user gets Spanish
 * without ever opening Settings.
 */
export type LanguagePreference = 'system' | SupportedLocale

/** Every legal stored value, in the order the Settings select renders them. */
export const LANGUAGE_PREFERENCES = ['system', ...SUPPORTED_LOCALES] as const

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export function isLanguagePreference(value: string): value is LanguagePreference {
  return (LANGUAGE_PREFERENCES as readonly string[]).includes(value)
}

/**
 * The device's preferred languages, most-preferred first. `navigator.languages`
 * where the webview provides it, falling back to the single `navigator.language`
 * and finally to nothing at all (SSR / a test environment without a navigator).
 */
function deviceLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (navigator.languages !== undefined && navigator.languages.length > 0) {
    return navigator.languages
  }
  return navigator.language ? [navigator.language] : []
}

/**
 * Resolve a stored preference to the locale to actually render in.
 *
 * `'system'` matches the device's language list against `SUPPORTED_LOCALES`
 * on the *primary subtag* only — `es-419`, `es-MX` and `es` all resolve to
 * `es`, because Agaric ships one neutral Spanish catalog rather than
 * regional variants. First match wins, so a device listing `['fr', 'es']`
 * gets Spanish rather than the English fallback.
 *
 * `languages` is a parameter so the resolution is testable without stubbing
 * a read-only `navigator` property.
 */
export function resolveLocale(
  preference: LanguagePreference,
  languages: readonly string[] = deviceLanguages(),
): SupportedLocale {
  if (preference !== 'system') return preference
  for (const tag of languages) {
    const primary = tag.split('-')[0]?.toLowerCase() ?? ''
    if (isSupportedLocale(primary)) return primary
  }
  return DEFAULT_LOCALE
}

/**
 * Language tag → its `date-fns` `Locale`. Seeded with `en` only: a
 * non-default locale registers its own from inside its lazily-imported
 * catalog chunk (`src/lib/i18n/es/index.ts`), so that locale's calendar
 * vocabulary lands in that chunk rather than in the startup bundle, and UI
 * language and date language arrive together in one payload.
 */
const DATE_LOCALES: Record<string, Locale> = {
  en: enUS,
}

/**
 * Register the `date-fns` `Locale` for a language tag. Called by each
 * lazily-loaded catalog chunk for its own locale, and by tests that need
 * `getDateLocale()` to resolve a synthetic tag.
 */
export function registerDateLocale(tag: string, locale: Locale): void {
  DATE_LOCALES[tag] = locale
}

/** Test-only: undo `registerDateLocale`. */
export function __unregisterDateLocaleForTests(tag: string): void {
  delete DATE_LOCALES[tag]
}

/** The registered `Locale` for `tag`, or `undefined` if none is loaded. */
export function lookupDateLocale(tag: string): Locale | undefined {
  return DATE_LOCALES[tag]
}
