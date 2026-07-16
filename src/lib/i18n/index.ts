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

/** Standalone translation function — safe to call outside React components. */
export const t = i18n.t.bind(i18n)

export { i18n }
