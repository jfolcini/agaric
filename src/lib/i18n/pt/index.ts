/**
 * The Portuguese catalog — the whole of it, in one lazily-loaded chunk,
 * loaded the same way and for the same reasons as `src/lib/i18n/es/index.ts`.
 *
 * Written as Brazilian Portuguese, the variant most Portuguese speakers
 * read: implied `você`, sentence case, Brazilian vocabulary (arquivo, tela,
 * excluir). A device set to `pt-PT` resolves here too until a `pt-PT`
 * variant ships; that variant would overlay this catalog with only the keys
 * whose wording differs (ficheiro, ecrã, eliminar), and register the
 * `date-fns` `pt` locale for itself.
 *
 * Complete: every namespace file mirrors its English sibling key for key,
 * and `locale-catalogs.test.ts` fails on a missing one.
 */

import { ptBR as ptDateFns } from 'date-fns/locale/pt-BR'

import { registerDateLocale } from '@/lib/i18n/locales'
import { agenda } from '@/lib/i18n/pt/agenda'
import { block } from '@/lib/i18n/pt/block'
import { common } from '@/lib/i18n/pt/common'
import { editor } from '@/lib/i18n/pt/editor'
import { errors } from '@/lib/i18n/pt/errors'
import { history } from '@/lib/i18n/pt/history'
import { pages } from '@/lib/i18n/pt/pages'
import { properties } from '@/lib/i18n/pt/properties'
import { references } from '@/lib/i18n/pt/references'
import { settings } from '@/lib/i18n/pt/settings'
import { shortcuts } from '@/lib/i18n/pt/shortcuts'
import { sync } from '@/lib/i18n/pt/sync'
import { toolbar } from '@/lib/i18n/pt/toolbar'

registerDateLocale('pt', ptDateFns)

export const pt: Record<string, string> = {
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
