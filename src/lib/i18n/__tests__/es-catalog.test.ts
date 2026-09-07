/**
 * Spanish catalog integrity (#4555).
 *
 * The `es` catalog is partial on purpose — namespaces land one translation
 * PR at a time and anything missing falls back to English. So "every key in
 * `en` exists in `es`" is NOT the rule here. What must hold for the keys
 * `es` does define:
 *
 *   1. The key exists in `en`. A key only Spanish has is a typo that renders
 *      Spanish to Spanish users and the raw key to everyone else.
 *   2. The `{{…}}` placeholders match `en` exactly, as a multiset. This is
 *      the highest-value check: a translator who drops or renames
 *      `{{count}}` ships a string that renders a literal `{{count}}` to the
 *      user, and nothing else in the estate would catch it.
 *   3. The key follows the catalog naming convention, widened to the CLDR
 *      plural categories (Spanish resolves `many` where English never can).
 *   4. Values are non-blank strings, matching the `en` suite.
 *   5. No value is byte-identical to its English source unless it is listed
 *      as deliberately the same. An accidental copy-paste is invisible
 *      otherwise: the string renders correctly in English and untranslated
 *      in Spanish, and the fallback would have produced the same screen
 *      without the entry.
 */

import { describe, expect, it } from 'vitest'

import { i18n } from '@/lib/i18n'
import { es } from '@/lib/i18n/es'

const KEY_CONVENTION_RE = /^[a-zA-Z]+(\.[a-zA-Z0-9]+)+(_zero|_one|_two|_few|_many|_other)?$/

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g

/**
 * Keys whose Spanish value is correctly byte-identical to the English one,
 * each with its reason (proper nouns, "OK", "PDF", …). Empty today: a key
 * that needs no translation is simply left out of the `es` catalog and
 * falls back, which is cheaper than an entry here. This exists for the case
 * where a locale must OVERRIDE a key back to the English text.
 */
const SAME_AS_ENGLISH: Readonly<Record<string, string>> = {}

function englishCatalog(): Record<string, string> {
  return i18n.getResourceBundle('en', 'translation') as Record<string, string>
}

function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? '').toSorted()
}

describe('the Spanish catalog', () => {
  const en = englishCatalog()
  const entries = Object.entries(es)

  it('is non-empty (a catalog nobody can reach is not a locale)', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it.each(entries)('%s exists in the English catalog', (key) => {
    expect(en, `es defines "${key}", which en does not`).toHaveProperty(key)
  })

  it.each(entries)('%s keeps every English interpolation placeholder', (key, value) => {
    expect(placeholders(value), `placeholder drift in "${key}"`).toEqual(
      placeholders(en[key] ?? ''),
    )
  })

  it.each(entries)('%s follows the namespace.name convention', (key) => {
    expect(key).toMatch(KEY_CONVENTION_RE)
  })

  it.each(entries)('%s has a non-blank string value', (key, value) => {
    expect(typeof value).toBe('string')
    expect(value.trim().length, `key "${key}" should not be blank`).toBeGreaterThan(0)
  })

  it.each(entries)('%s is actually translated, not a copy of the English', (key, value) => {
    if (key in SAME_AS_ENGLISH) return
    expect(value, `"${key}" is identical to its English source`).not.toBe(en[key])
  })
})
