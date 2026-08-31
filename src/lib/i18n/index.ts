/**
 * i18n configuration — internationalization framework.
 *
 * Usage in components:
 *   import { useTranslation } from 'react-i18next'
 *   const { t } = useTranslation()
 *   <p>{t('empty.noBlocks')}</p>
 *
 * The English string catalog lives in sibling namespace files
 * (common.ts, agenda.ts, editor.ts, …). Each exports a flat
 * `Record<string, string>` of dotted keys. They are merged
 * verbatim into a single `en.translation` resource here.
 *
 * To add a new key: pick the namespace file that matches the key's
 * first segment and add the entry there. Do NOT add new locale
 * resources — this is a single-locale app (lng/fallbackLng pinned
 * to 'en').
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { agenda } from '@/lib/i18n/agenda'
import { block } from '@/lib/i18n/block'
import { common } from '@/lib/i18n/common'
import { editor } from '@/lib/i18n/editor'
import { errors } from '@/lib/i18n/errors'
import { history } from '@/lib/i18n/history'
import { pages } from '@/lib/i18n/pages'
import { properties } from '@/lib/i18n/properties'
import { references } from '@/lib/i18n/references'
import { settings } from '@/lib/i18n/settings'
import { shortcuts } from '@/lib/i18n/shortcuts'
import { sync } from '@/lib/i18n/sync'
import { toolbar } from '@/lib/i18n/toolbar'

const translation: Record<string, string> = {
  ...common,
  ...errors,
  ...toolbar,
  ...block,
  ...agenda,
  ...editor,
  ...pages,
  ...properties,
  ...references,
  ...history,
  ...sync,
  ...shortcuts,
  ...settings,
}

const resources = {
  en: {
    translation,
  },
}

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
})

/**
 * #4555 — keep `document.documentElement.lang` in sync with the resolved
 * i18next language, instead of the `lang="en"` `index.html` hardcodes at
 * build time and nothing in `src/` ever updated. Two live bugs this fixes:
 *   - Every AT announces content with English phonetics regardless of the
 *     actual page language.
 *   - `useVoiceInput.ts` derives `SpeechRecognition.lang` from
 *     `document.documentElement.lang || 'en-US'`, so a stale attribute feeds
 *     voice dictation the wrong acoustic model.
 *
 * Set once immediately below (this module is imported synchronously before
 * React renders — see `src/main.tsx`) and again on every `languageChanged`
 * event, mirroring the write-on-change DOM-applying-preference pattern
 * `useTheme.ts` uses for theme classes (a `useEffect` keyed on the resolved
 * value). This module can't use that hook shape — it runs before any
 * component mounts and must own the FIRST paint, not just react to later
 * ones — so it subscribes directly to i18next's own event bus instead,
 * which is available immediately after `init()` and needs no React tree.
 *
 * Phase 0 keeps `lng` pinned to `'en'` (no language switch exists yet), so
 * `languageChanged` never actually fires in production today — this
 * listener is dormant machinery, wired and tested now so it is provably
 * correct before Phase 1 ever calls `changeLanguage()`.
 */
function applyDocumentLang(lng: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lng
}
applyDocumentLang(i18n.language)
i18n.on('languageChanged', applyDocumentLang)

/** Standalone translation function — safe to call outside React components. */
export const t = i18n.t.bind(i18n)

export { i18n }
