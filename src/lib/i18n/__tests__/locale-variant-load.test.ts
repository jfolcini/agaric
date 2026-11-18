/**
 * A regional variant's catalog holds only its overrides, so `loadLocale`
 * merges its base language's catalog before its own. No variant ships yet:
 * this file pretends `es` is a variant of `pt`, which is why it is its own
 * file — `vi.mock` is hoisted per module graph.
 */

import { expect, it, vi } from 'vitest'

import { i18n } from '@/lib/i18n'
import { loadLocale } from '@/lib/i18n/set-locale'

vi.mock('@/lib/i18n/locales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/i18n/locales')>()
  return { ...actual, baseLocale: (tag: string) => (tag === 'es' ? 'pt' : tag) }
})

it('merges the base catalog before the variant', async () => {
  const addBundle = vi.spyOn(i18n, 'addResourceBundle')

  await loadLocale('es')

  expect(addBundle.mock.calls.map((call) => call[0])).toEqual(['pt', 'es'])
})
