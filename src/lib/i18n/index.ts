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
 * to 'en'). See REVIEW-LATER.md MAINT-126 for the rationale.
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { agenda } from './agenda'
import { block } from './block'
import { common } from './common'
import { conflicts } from './conflicts'
import { editor } from './editor'
import { errors } from './errors'
import { pages } from './pages'
import { properties } from './properties'
import { references } from './references'
import { settings } from './settings'
import { shortcuts } from './shortcuts'
import { sync } from './sync'
import { toolbar } from './toolbar'

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
  ...conflicts,
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

/** Standalone translation function — safe to call outside React components. */
export const t = i18n.t.bind(i18n)

export { i18n }
