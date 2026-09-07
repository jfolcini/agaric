/**
 * The one failure mode a lazily-loaded catalog has: the chunk doesn't load
 * (#4555). Its own file because `vi.mock` is hoisted per module graph — the
 * Spanish catalog has to be breakable for the whole file, and every other
 * locale suite needs it working.
 *
 * The contract: a user who picks Spanish and doesn't get it keeps a working
 * English UI, and the failure is logged rather than swallowed. A
 * half-switched app — `i18n.language === 'es'` with no `es` bundle, so every
 * string silently falls back and `document.documentElement.lang` lies to
 * `useVoiceInput` — is the outcome this prevents.
 *
 * The mock fails on demand rather than always, because "the rejection is
 * not memoized" is only observable across a load that FAILS and then one
 * that SUCCEEDS: a memoized rejection also rejects, so asserting a second
 * rejection would pass whether or not the entry was evicted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@/lib/i18n'
import { loadLocale, setLocale } from '@/lib/i18n/set-locale'
import { logger } from '@/lib/logger'

const chunk = vi.hoisted(() => ({ shouldFail: true }))

vi.mock('@/lib/i18n/es', () => ({
  get es(): Record<string, string> {
    if (chunk.shouldFail) throw new Error('chunk load failed')
    return { 'error.generic': 'Algo ha salido mal' }
  },
}))

describe('a locale catalog chunk that fails to load', () => {
  beforeEach(() => {
    chunk.shouldFail = true
    vi.restoreAllMocks()
  })

  it('leaves the app on its current language and logs', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})

    await setLocale('es')

    expect(i18n.language).toBe('en')
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(false)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toBe('i18n')
  })

  it('does not cache the failure, so picking the language again retries', async () => {
    await expect(loadLocale('es')).rejects.toThrow('chunk load failed')
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(false)

    // The user picks Spanish again, and this time the chunk resolves. A
    // memoized rejection would hand back the first failure forever, so the
    // user could never recover without a restart.
    chunk.shouldFail = false
    await expect(loadLocale('es')).resolves.toBeUndefined()
    expect(i18n.hasResourceBundle('es', 'translation')).toBe(true)
  })
})
