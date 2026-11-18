/**
 * The French catalog — the whole of it, in one lazily-loaded chunk, loaded
 * the same way and for the same reasons as `src/lib/i18n/es/index.ts`.
 *
 * `vous`, infinitive buttons ("Créer une page"), French typography: `’` for
 * the apostrophe and a no-break space before `:` `;` `?` `!`. A regional
 * variant (`fr-CA`) would overlay this catalog with only the keys whose
 * wording differs.
 *
 * Complete: every namespace file mirrors its English sibling key for key,
 * and `locale-catalogs.test.ts` fails on a missing one.
 */

import { fr as frDateFns } from 'date-fns/locale/fr'

import { agenda } from '@/lib/i18n/fr/agenda'
import { block } from '@/lib/i18n/fr/block'
import { common } from '@/lib/i18n/fr/common'
import { editor } from '@/lib/i18n/fr/editor'
import { errors } from '@/lib/i18n/fr/errors'
import { history } from '@/lib/i18n/fr/history'
import { pages } from '@/lib/i18n/fr/pages'
import { properties } from '@/lib/i18n/fr/properties'
import { references } from '@/lib/i18n/fr/references'
import { settings } from '@/lib/i18n/fr/settings'
import { shortcuts } from '@/lib/i18n/fr/shortcuts'
import { sync } from '@/lib/i18n/fr/sync'
import { toolbar } from '@/lib/i18n/fr/toolbar'
import { registerDateLocale } from '@/lib/i18n/locales'

registerDateLocale('fr', frDateFns)

export const fr: Record<string, string> = {
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
