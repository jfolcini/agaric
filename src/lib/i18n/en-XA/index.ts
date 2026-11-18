/**
 * The pseudo-locale `en-XA`: English made to look foreign, for checking a
 * layout without reading another language (`docs/TRANSLATING.md`).
 *
 * Generated from the English catalog when it loads, so it never falls behind
 * English, and reached only through `loadLocale('en-XA')`, so no one
 * downloads it unless they pick it. Every value:
 * - swaps each letter for an accented look-alike, so it stays readable;
 * - grows by about 40%, as German and French often do, so a label that only
 *   fits in English overflows here;
 * - sits inside `⟦…⟧`, so on-screen text without the markers bypassed `t()`
 *   and a missing `⟧` is truncation.
 * Placeholders, inline tags and `ENGLISH_IN_EVERY_LOCALE` values stay as they
 * are, so interpolation, `Trans` and the parsers that read them keep working.
 * Dates follow `en`: a variant with no date-fns locale dates like its base.
 */

import { i18n } from '@/lib/i18n'
import { ENGLISH_IN_EVERY_LOCALE } from '@/lib/i18n/english-in-every-locale'
import { DEFAULT_LOCALE } from '@/lib/i18n/locales'

/** Each letter's look-alike: stripped of its accent, it reads as the letter it replaces. */
const ACCENTED: Record<string, string> = {
  a: 'á',
  b: 'ḃ',
  c: 'ç',
  d: 'ḋ',
  e: 'é',
  f: 'ḟ',
  g: 'ğ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ĺ',
  m: 'ṁ',
  n: 'ñ',
  o: 'ó',
  p: 'ṗ',
  // Unicode has no precomposed accented q.
  q: 'q\u0303',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'ú',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
}

const GROWTH = 0.4
// Spaced, so a padded sentence still wraps where a translated one would.
const PADDING = ' ~'

/** `{{placeholder}}` or an inline tag (`<strong>`, `</strong>`, `<m0/>`), captured so `split` keeps it. */
const PRESERVED = /(\{\{[^}]*\}\}|<\/?[a-zA-Z0-9]+\s*\/?>)/

function accent(char: string): string {
  const lower = char.toLowerCase()
  const accented = ACCENTED[lower]
  if (accented === undefined) return char
  return char === lower ? accented : accented.toUpperCase()
}

export function pseudoLocalize(value: string): string {
  let textLength = 0
  const body = value
    .split(PRESERVED)
    .map((part, i) => {
      if (i % 2 === 1) return part
      textLength += part.length
      return Array.from(part, accent).join('')
    })
    .join('')
  const padding = PADDING.repeat(Math.ceil((textLength * GROWTH) / PADDING.length))
  return `⟦${body}${padding}⟧`
}

const english = i18n.getResourceBundle(DEFAULT_LOCALE, 'translation') as Record<string, string>

export const enXA: Record<string, string> = Object.fromEntries(
  Object.entries(english).map(([key, value]) => [
    key,
    ENGLISH_IN_EVERY_LOCALE.includes(key) ? value : pseudoLocalize(value),
  ]),
)
