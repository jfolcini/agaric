/**
 * Tests for the locale registry (#4555) — how a stored language preference
 * becomes the locale the app renders in, how a regional variant layers over
 * its base language, and how catalogs load.
 */

import { enUS } from 'date-fns/locale/en-US'
import { es as esDateFns } from 'date-fns/locale/es'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@/lib/i18n'
import {
  __unregisterDateLocaleForTests,
  baseLocale,
  DEFAULT_LOCALE,
  isLanguagePreference,
  isSupportedLocale,
  LANGUAGE_PREFERENCES,
  lookupDateLocale,
  registerDateLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from '@/lib/i18n/locales'
import { loadLocale, setLocale } from '@/lib/i18n/set-locale'

/** ISO 639 reserves `qaa`–`qtz` for local use, so no catalog will ever ship under them. */
const UNSHIPPED = 'qaa'
const UNSHIPPED_REGION = 'qab-QA'

describe('resolveLocale', () => {
  it('returns an explicit preference verbatim, ignoring the device', () => {
    expect(resolveLocale('en', ['es-ES'])).toBe('en')
    expect(resolveLocale('es', ['en-GB'])).toBe('es')
    expect(resolveLocale('pt', ['es-ES'])).toBe('pt')
  })

  it('matches a regional device tag to its base language when no variant ships', () => {
    expect(resolveLocale('system', ['es-ES'])).toBe('es')
    expect(resolveLocale('system', ['es-419'])).toBe('es')
    expect(resolveLocale('system', ['ES-mx'])).toBe('es')
    expect(resolveLocale('system', ['es'])).toBe('es')
    expect(resolveLocale('system', ['pt-BR'])).toBe('pt')
    expect(resolveLocale('system', ['pt-PT'])).toBe('pt')
    expect(resolveLocale('system', ['de-AT'])).toBe('de')
    expect(resolveLocale('system', ['fr-CA'])).toBe('fr')
  })

  it("matches a device set to Android's developer pseudo-locale", () => {
    expect(resolveLocale('system', ['en-XA'])).toBe('en-XA')
  })

  it('strips subtags one at a time, so a script subtag does not block the match', () => {
    expect(resolveLocale('system', ['pt-Latn-BR'])).toBe('pt')
  })

  it('takes the first supported language in the device list, not the first entry', () => {
    expect(resolveLocale('system', [UNSHIPPED_REGION, UNSHIPPED, 'es-MX'])).toBe('es')
    expect(resolveLocale('system', [UNSHIPPED_REGION, 'pt-BR', 'es-MX'])).toBe('pt')
  })

  it('skips a malformed device tag instead of throwing', () => {
    expect(resolveLocale('system', ['not a tag', 'es'])).toBe('es')
  })

  it('falls back to the default locale when nothing matches', () => {
    expect(resolveLocale('system', [UNSHIPPED_REGION, UNSHIPPED])).toBe(DEFAULT_LOCALE)
    expect(resolveLocale('system', [])).toBe(DEFAULT_LOCALE)
  })
})

describe('the supported-locale allowlist', () => {
  it('accepts every shipped locale and rejects anything else', () => {
    for (const locale of SUPPORTED_LOCALES) expect(isSupportedLocale(locale)).toBe(true)
    expect(isSupportedLocale(UNSHIPPED)).toBe(false)
    expect(isSupportedLocale('es-ES')).toBe(false)
    expect(isSupportedLocale('toString')).toBe(false)
    expect(isSupportedLocale('')).toBe(false)
  })

  it('accepts every stored preference value and rejects anything else', () => {
    for (const pref of LANGUAGE_PREFERENCES) expect(isLanguagePreference(pref)).toBe(true)
    expect(isLanguagePreference('auto')).toBe(false)
    expect(isLanguagePreference(UNSHIPPED)).toBe(false)
  })

  it('includes the default locale, which must be statically bundled', () => {
    expect(isSupportedLocale(DEFAULT_LOCALE)).toBe(true)
    expect(i18n.hasResourceBundle(DEFAULT_LOCALE, 'translation')).toBe(true)
  })

  it('names every base locale its own base', () => {
    for (const locale of SUPPORTED_LOCALES.filter((l) => !l.includes('-'))) {
      expect(baseLocale(locale)).toBe(locale)
    }
  })
})

// A variant ships only its overrides. This pins the i18next behaviour that
// claim rests on — the variant, then its primary subtag, then `fallbackLng` —
// with throwaway bundles under a tag no catalog uses.
describe('a regional variant over its base language', () => {
  const VARIANT = 'zz-ZZ'
  const BASE = 'zz'

  afterEach(async () => {
    i18n.removeResourceBundle(VARIANT, 'translation')
    i18n.removeResourceBundle(BASE, 'translation')
    __unregisterDateLocaleForTests(BASE)
    await i18n.changeLanguage(DEFAULT_LOCALE)
  })

  it('renders its own override, then its base, then English', async () => {
    i18n.addResourceBundle(BASE, 'translation', {
      'error.generic': 'base generic',
      'error.saveFailed': 'base save',
    })
    i18n.addResourceBundle(VARIANT, 'translation', { 'error.generic': 'variant generic' })
    await i18n.changeLanguage(VARIANT)

    expect(i18n.t('error.generic')).toBe('variant generic')
    expect(i18n.t('error.saveFailed')).toBe('base save')
    expect(i18n.t('error.loadFailed')).toBe(i18n.getFixedT('en')('error.loadFailed'))
  })

  it('dates like its base when it registers no date-fns locale of its own', () => {
    expect(lookupDateLocale(VARIANT)).toBeUndefined()
    registerDateLocale(BASE, esDateFns)
    expect(lookupDateLocale(VARIANT)).toBe(esDateFns)
    expect(lookupDateLocale('en')).toBe(enUS)
  })
})

describe('loadLocale / setLocale', () => {
  afterEach(async () => {
    await i18n.changeLanguage(DEFAULT_LOCALE)
  })

  it('is a no-op for the statically-bundled default locale', async () => {
    await expect(loadLocale(DEFAULT_LOCALE)).resolves.toBeUndefined()
  })

  it('loads the Spanish catalog and switches to it', async () => {
    await setLocale('es')
    expect(i18n.language).toBe('es')
    expect(i18n.t('error.generic')).toBe('Algo ha salido mal')
  })

  it('loads the Portuguese catalog and its date-fns locale, and switches to it', async () => {
    await setLocale('pt')
    expect(i18n.language).toBe('pt')
    expect(i18n.t('error.generic')).toBe('Algo deu errado')
    expect(lookupDateLocale('pt')?.code).toBe('pt-BR')
  })

  // A variant dates like its base (`en-XA` like `en`).
  it.each(SUPPORTED_LOCALES)('%s dates in its language once its catalog loads', async (tag) => {
    await loadLocale(tag)
    expect(lookupDateLocale(tag)?.code.split('-')[0]).toBe(tag.split('-')[0])
  })

  it('merges the catalog exactly once, however many callers ask', async () => {
    await loadLocale('es')
    const addBundle = vi.spyOn(i18n, 'addResourceBundle')
    await Promise.all([loadLocale('es'), loadLocale('es'), loadLocale('es')])
    expect(addBundle).not.toHaveBeenCalled()
    addBundle.mockRestore()
  })
})
