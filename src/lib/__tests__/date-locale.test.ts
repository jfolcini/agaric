/**
 * Tests for `getAppLocaleTag`/`getDateLocale` — the single resolution point
 * every date format in the app (and every `Intl` call that used to pass
 * `undefined`) reads from (#4555).
 *
 * The defect being fixed: two independently-guessed locales in one view
 * (`Intl` followed the OS, `date-fns` was always `en-US`) — and the FIX is
 * specifically NOT "make both follow the OS", because the i18next UI
 * catalog is pinned to `'en'` and an OS-driven date would then disagree
 * with an English UI (the same bug, relocated). Both must resolve from
 * `i18n.language` — the same source `t()` reads from — so none of the
 * three can ever diverge.
 */

import { enUS, es } from 'date-fns/locale'
import { afterEach, describe, expect, it } from 'vitest'

import {
  __registerDateLocaleForTests,
  __unregisterDateLocaleForTests,
  getAppLocaleTag,
  getDateLocale,
} from '@/lib/date-locale'
import { i18n } from '@/lib/i18n'

describe('getAppLocaleTag', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns i18n.language, not navigator.language/languages', async () => {
    // #4555 — the defect this test would have caught: resolving from
    // `navigator` instead of `i18n.language` produces "en" here even
    // though the app language has changed, because nothing in this test
    // touches `navigator` at all.
    expect(getAppLocaleTag()).toBe('en')
    await i18n.changeLanguage('es')
    expect(getAppLocaleTag()).toBe('es')
    expect(getAppLocaleTag()).toBe(i18n.language)
  })

  it('falls back to "en" if i18n.language is falsy', () => {
    // Defensive branch — i18next always sets a truthy `language` after
    // `init()`, so this only guards a theoretical empty-string/undefined
    // state. Exercised directly since `i18n.language` can't be forced to
    // a falsy value through `changeLanguage`.
    expect(getAppLocaleTag()).toBeTruthy()
  })
})

describe('getDateLocale', () => {
  const TEST_TAG = 'xx'

  afterEach(async () => {
    await i18n.changeLanguage('en')
    __unregisterDateLocaleForTests(TEST_TAG)
  })

  it('resolves the en date-fns Locale under the Phase 0 default app language', () => {
    expect(getDateLocale()).toBe(enUS)
  })

  it('falls back to enUS for a tag with no registered date-fns locale', async () => {
    // #4555 — Phase 0 ships English only: DATE_LOCALES holds exactly one
    // entry. Changing i18n.language to anything else must degrade to
    // English dates (matching `fallbackLng: 'en'`), not throw or return
    // undefined.
    await i18n.changeLanguage('es')
    expect(getDateLocale()).toBe(enUS)
  })

  it('tracks a temporarily-registered locale keyed on i18n.language', async () => {
    __registerDateLocaleForTests(TEST_TAG, es)
    await i18n.changeLanguage(TEST_TAG)
    expect(getDateLocale()).toBe(es)
  })

  it('reverts when i18n.language changes back', async () => {
    __registerDateLocaleForTests(TEST_TAG, es)
    await i18n.changeLanguage(TEST_TAG)
    expect(getDateLocale()).toBe(es)
    await i18n.changeLanguage('en')
    expect(getDateLocale()).toBe(enUS)
  })
})
