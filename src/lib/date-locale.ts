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
 * `getDateLocale()` is keyed on. Since `src/lib/i18n/index.ts` pins `lng` to
 * `'en'` (Phase 0 ships no second locale), `i18n.language` is always
 * `'en'` today — so every date renders English, matching the English UI.
 * That is the correct Phase 0 end state: one honest locale, not "dates
 * follow the OS, UI follows English" repackaged.
 *
 * `DATE_LOCALES` therefore holds exactly one entry (`en`) — a Spanish
 * `date-fns/locale` import would be dead code today (no code path can ever
 * select it, since `i18n.language` can never be `'es'`) plus ~1KB of
 * unused Spanish calendar vocabulary in the bundle. The map is a plain
 * mutable `Record`, not `as const`, specifically so Phase 1's
 * `SUPPORTED_LOCALES` registry can add entries here without restructuring
 * this module.
 */

import type { Locale } from 'date-fns'
import { enUS } from 'date-fns/locale'

import { i18n } from '@/lib/i18n'

const DATE_LOCALES: Record<string, Locale> = {
  en: enUS,
}

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
  return DATE_LOCALES[getAppLocaleTag()] ?? enUS
}

/**
 * Test-only: register a synthetic locale under `tag` so falsification
 * tests can prove `getDateLocale()`/`getAppLocaleTag()` track
 * `i18n.language` — by driving `i18n.changeLanguage(tag)` — without
 * shipping a real second locale (Phase 0 ships English only). Never called
 * from production code. Mirrors `__resetPriorityLevelsForTests` in
 * `priority-levels.ts`.
 */
export function __registerDateLocaleForTests(tag: string, locale: Locale): void {
  DATE_LOCALES[tag] = locale
}

/** Test-only: undo `__registerDateLocaleForTests`. */
export function __unregisterDateLocaleForTests(tag: string): void {
  delete DATE_LOCALES[tag]
}
