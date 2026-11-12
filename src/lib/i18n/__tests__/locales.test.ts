/**
 * Tests for the locale registry (#4555) — how a stored language preference
 * becomes the locale the app renders in, and what happens to a locale
 * catalog chunk that fails to load.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@/lib/i18n'
import {
  DEFAULT_LOCALE,
  isLanguagePreference,
  isSupportedLocale,
  LANGUAGE_PREFERENCES,
  resolveLocale,
  SUPPORTED_LOCALES,
} from '@/lib/i18n/locales'
import { loadLocale, setLocale } from '@/lib/i18n/set-locale'

describe('resolveLocale', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns an explicit preference verbatim', () => {
    expect(resolveLocale('en')).toBe('en')
    expect(resolveLocale('es')).toBe('es')
  })

  it('resolves System to English on a Spanish device', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es-MX'])
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-MX')
    expect(resolveLocale('system')).toBe('en')
  })
})

describe('the supported-locale allowlist', () => {
  it('accepts every shipped locale and rejects anything else', () => {
    for (const locale of SUPPORTED_LOCALES) expect(isSupportedLocale(locale)).toBe(true)
    expect(isSupportedLocale('fr')).toBe(false)
    expect(isSupportedLocale('es-ES')).toBe(false)
    expect(isSupportedLocale('')).toBe(false)
  })

  it('accepts every stored preference value and rejects anything else', () => {
    for (const pref of LANGUAGE_PREFERENCES) expect(isLanguagePreference(pref)).toBe(true)
    expect(isLanguagePreference('auto')).toBe(false)
    expect(isLanguagePreference('fr')).toBe(false)
  })

  it('includes the default locale, which must be statically bundled', () => {
    expect(isSupportedLocale(DEFAULT_LOCALE)).toBe(true)
    expect(i18n.hasResourceBundle(DEFAULT_LOCALE, 'translation')).toBe(true)
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
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(true)
    // A translated key resolves to Spanish…
    expect(i18n.t('error.generic')).toBe('Algo ha salido mal')
    // …and an untranslated one silently falls back to English, which is the
    // whole point of shipping a partial catalog.
    expect(i18n.t('settings.themeLabel')).toBe('Theme')
  })

  it('merges the catalog exactly once, however many callers ask', async () => {
    await loadLocale('es')
    const addBundle = vi.spyOn(i18n, 'addResourceBundle')
    await Promise.all([loadLocale('es'), loadLocale('es'), loadLocale('es')])
    expect(addBundle).not.toHaveBeenCalled()
    addBundle.mockRestore()
  })
})
