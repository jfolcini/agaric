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
 * `loadLocale()` in `./set-locale.ts`.
 *
 * Adding a language: an entry here, a `src/lib/i18n/<tag>/` directory that
 * mirrors the English namespace files, and its loader in `set-locale.ts`
 * (`tsc` fails until it exists). `locale-catalogs.test.ts` then fails until
 * the catalog carries every English key.
 *
 * Adding a regional variant (`pt-PT`, `es-419`): the same three steps, but
 * the variant's catalog holds ONLY the keys whose wording differs from its
 * base language (the tag's primary subtag, `pt`). `loadLocale` loads the
 * base first, and i18next resolves every key the variant does not override
 * through it: `pt-PT` → `pt` → `en`.
 */

import type { Locale } from 'date-fns'
import { enUS } from 'date-fns/locale/en-US'

/**
 * Every locale the app can render in, keyed by BCP 47 tag, in the order the
 * Settings select lists them: alphabetical by `nativeName`, which is what
 * that select shows — each language named in itself, so a reader finds their
 * own language whatever the UI is currently in.
 */
export const LOCALES = {
  de: { nativeName: 'Deutsch' },
  en: { nativeName: 'English' },
  es: { nativeName: 'Español' },
  fr: { nativeName: 'Français' },
  pt: { nativeName: 'Português' },
  'en-XA': { nativeName: 'Pseudo-locale (en-XA)' },
} as const satisfies Record<string, { readonly nativeName: string }>

export type SupportedLocale = keyof typeof LOCALES

/** Every locale the app can render in. `en` is bundled; the rest are lazy. */
export const SUPPORTED_LOCALES = Object.keys(LOCALES) as readonly SupportedLocale[]

/** The statically-bundled locale, and i18next's `fallbackLng`. */
export const DEFAULT_LOCALE = 'en' satisfies SupportedLocale

/**
 * A variant of `en` generated from it (`./en-XA/index.ts`) to check layouts,
 * not a language: Settings offers it only in debug mode. `XA` is the
 * private-use region of Android's developer pseudo-locale, so a device set
 * to that resolves to it.
 */
export const PSEUDO_LOCALE = 'en-XA' satisfies SupportedLocale

/**
 * The stored preference: a concrete locale, or `'system'` to follow the
 * device. `'system'` is the default, so a Spanish-OS user gets Spanish
 * without ever opening Settings.
 */
export type LanguagePreference = 'system' | SupportedLocale

/** Every legal stored value, in the order the Settings select renders them. */
export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ['system', ...SUPPORTED_LOCALES]

export function isSupportedLocale(value: string): value is SupportedLocale {
  return Object.hasOwn(LOCALES, value)
}

export function isLanguagePreference(value: string): value is LanguagePreference {
  return value === 'system' || isSupportedLocale(value)
}

/**
 * The base language a regional variant overlays — its primary subtag, when
 * that is itself a shipped locale (`pt-PT` → `pt`). A base locale is its own
 * base.
 */
export function baseLocale(tag: SupportedLocale): SupportedLocale {
  const primary = tag.split('-')[0] ?? tag
  return isSupportedLocale(primary) ? primary : tag
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

/** `tag` in canonical BCP 47 case (`ES-mx` → `es-MX`), or `''` if it is not a valid tag. */
function canonicalTag(tag: string): string {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? ''
  } catch {
    return ''
  }
}

/**
 * Resolve a stored preference to the locale to actually render in.
 *
 * `'system'` walks the device's language list in order and, for each tag,
 * tries it and then each shorter prefix (RFC 4647 lookup: `pt-BR` → `pt`,
 * `zh-Hant-TW` → `zh-Hant` → `zh`). So a device tag matches a regional
 * variant when one ships and its base language otherwise. First match wins,
 * so a device listing `['fr', 'es']` gets Spanish rather than the English
 * fallback.
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
    for (let candidate = canonicalTag(tag); candidate !== '';) {
      if (isSupportedLocale(candidate)) return candidate
      candidate = candidate.slice(0, Math.max(candidate.lastIndexOf('-'), 0))
    }
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

/**
 * The registered `Locale` for `tag`, else its primary language's (a variant
 * that registers none dates like its base), or `undefined` if neither is
 * loaded.
 */
export function lookupDateLocale(tag: string): Locale | undefined {
  return DATE_LOCALES[tag] ?? DATE_LOCALES[tag.split('-')[0] ?? tag]
}
