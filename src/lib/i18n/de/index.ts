/**
 * The German catalog — the whole of it, in one lazily-loaded chunk, loaded
 * the same way and for the same reasons as `src/lib/i18n/es/index.ts`.
 *
 * Informal `du`, infinitive buttons ("Seite erstellen"), standard German
 * vocabulary. A regional variant (`de-CH`, which writes "ss" for "ß") would
 * overlay this catalog with only the keys whose wording differs.
 *
 * Complete: every namespace file mirrors its English sibling key for key,
 * and `locale-catalogs.test.ts` fails on a missing one.
 */

import { de as deDateFns } from 'date-fns/locale/de'

import { agenda } from '@/lib/i18n/de/agenda'
import { block } from '@/lib/i18n/de/block'
import { common } from '@/lib/i18n/de/common'
import { editor } from '@/lib/i18n/de/editor'
import { errors } from '@/lib/i18n/de/errors'
import { history } from '@/lib/i18n/de/history'
import { pages } from '@/lib/i18n/de/pages'
import { properties } from '@/lib/i18n/de/properties'
import { references } from '@/lib/i18n/de/references'
import { settings } from '@/lib/i18n/de/settings'
import { shortcuts } from '@/lib/i18n/de/shortcuts'
import { sync } from '@/lib/i18n/de/sync'
import { toolbar } from '@/lib/i18n/de/toolbar'
import { registerDateLocale } from '@/lib/i18n/locales'

registerDateLocale('de', deDateFns)

export const de: Record<string, string> = {
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
