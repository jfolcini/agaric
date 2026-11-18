/**
 * The Spanish catalog — the whole of it, in one lazily-loaded chunk.
 *
 * Reached only through `loadLocale('es')` in `src/lib/i18n/set-locale.ts`,
 * which `import()`s this module. Nothing imports it statically, so Rolldown
 * emits it as its own chunk and an English user never downloads or parses a
 * byte of it. Same trick, and the same reason, as the emoji dataset in
 * `src/components/EmojiPicker/EmojiPicker.tsx`: this is a same-bundle
 * dynamic `import()`, not a network fetch — Tauri serves everything from
 * disk, so there is no offline failure mode.
 *
 * Complete: every namespace file mirrors its English sibling key for key,
 * and `locale-catalogs.test.ts` fails on a missing one. Register and voice:
 * `tú`, sentence case, neutral Spanish (no Spain- or Latin-America-specific
 * vocabulary). A regional variant (`es-419`) would overlay this catalog with
 * only the keys whose wording differs.
 *
 * The `date-fns` Spanish locale is registered here, into the leaf registry
 * in `locales.ts`, for exactly the same reason the strings live here: a
 * static import would put Spanish month and weekday vocabulary in the
 * startup chunk for every user. Registering it from inside this chunk keeps
 * UI language and date language switching together, in one payload.
 */

import { es as esDateFns } from 'date-fns/locale/es'

import { agenda } from '@/lib/i18n/es/agenda'
import { block } from '@/lib/i18n/es/block'
import { common } from '@/lib/i18n/es/common'
import { editor } from '@/lib/i18n/es/editor'
import { errors } from '@/lib/i18n/es/errors'
import { history } from '@/lib/i18n/es/history'
import { pages } from '@/lib/i18n/es/pages'
import { properties } from '@/lib/i18n/es/properties'
import { references } from '@/lib/i18n/es/references'
import { settings } from '@/lib/i18n/es/settings'
import { shortcuts } from '@/lib/i18n/es/shortcuts'
import { sync } from '@/lib/i18n/es/sync'
import { toolbar } from '@/lib/i18n/es/toolbar'
import { registerDateLocale } from '@/lib/i18n/locales'

registerDateLocale('es', esDateFns)

export const es: Record<string, string> = {
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
