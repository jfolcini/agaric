/**
 * getDateLocale / getAppLocaleTag — the single resolution point every date
 * format in the app reads from.
 *
 * #4555 Phase 0 — before this module existed, date formatting ran through
 * TWO independent systems that each guessed the locale their own way:
 * `Intl`/`toLocaleDateString(undefined, …)` sites resolved the OS/browser
 * locale, while every `date-fns` `format()` call was implicitly `en-US`
 * with no `locale:` option anywhere in `src/`. That produced two
 * disagreeing languages in one view.
 *
 * The fix is NOT to make both follow the OS — that only relocates the same
 * bug (dates would then follow the OS while the i18next UI catalog stays
 * pinned to `'en'`, so a non-English-OS user gets an English UI next to
 * non-English dates: still two languages in one view). Both `Intl` and
 * `date-fns` must resolve from the SAME source as the UI text itself:
 * `i18n.language`. That is `getAppLocaleTag()` below, and it is what
 * `getDateLocale()` is keyed on.
 *
 * The tag → `date-fns` `Locale` map itself lives in `@/lib/i18n/locales`,
 * not here: a lazily-loaded catalog chunk registers its own locale into it,
 * and this module imports `@/lib/i18n`, so holding the map here would make
 * that registration an import cycle. This module owns the RESOLUTION
 * against the current language; `locales.ts` owns the per-locale data.
 */

import type { Locale } from 'date-fns'
import { enUS } from 'date-fns/locale'

import { i18n } from '@/lib/i18n'
import { lookupDateLocale } from '@/lib/i18n/locales'

/**
 * The app's current language tag — `i18n.language` itself, the same value
 * driving every `t()` call in the UI. This is the ONE source `date-fns`
 * call sites (`getDateLocale()`) and `Intl` call sites (pass this instead
 * of `undefined`) both resolve from, so UI text and date text can never
 * disagree.
 */
export function getAppLocaleTag(): string {
  return i18n.language || 'en'
}

/**
 * The `date-fns` `Locale` to pass as `{ locale }` to every `format()` call
 * that renders a textual token (`EEE`/`EEEE`/`MMM`/`MMMM`/`LLLL`). Call this
 * fresh at format time (not once at module scope) so it tracks
 * `i18n.language` across a future `changeLanguage()`, rather than freezing
 * at import time. Falls back to `enUS` for a tag with no registered
 * `date-fns` locale (defensive — `DATE_LOCALES` and `i18n`'s
 * `fallbackLng: 'en'` should already agree).
 */
export function getDateLocale(): Locale {
  return lookupDateLocale(getAppLocaleTag()) ?? enUS
}
