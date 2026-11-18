/**
 * The pseudo-locale generator (`src/lib/i18n/en-XA/index.ts`). Its catalog is
 * also held to the rules every locale follows by `locale-catalogs.test.ts`;
 * this pins what makes it a layout check.
 */

import { describe, expect, it } from 'vitest'

import { i18n } from '@/lib/i18n'
import { enXA, pseudoLocalize } from '@/lib/i18n/en-XA'
import { ENGLISH_IN_EVERY_LOCALE } from '@/lib/i18n/english-in-every-locale'
import { DEFAULT_LOCALE } from '@/lib/i18n/locales'

const LETTERS = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')

describe('pseudoLocalize', () => {
  it('accents the text, pads it and wraps it in markers', () => {
    expect(pseudoLocalize('Settings')).toBe('⟦Šéţţíñğš ~ ~⟧')
  })

  it('swaps every letter for a look-alike that reads as the same letter', () => {
    // One letter is padded by one ` ~` unit, so the accented letter sits between `⟦` and ` ~⟧`.
    const accented = LETTERS.map((letter) => pseudoLocalize(letter).slice(1, -' ~⟧'.length))
    expect(accented.filter((swapped, i) => swapped === LETTERS[i])).toEqual([])
    expect(accented.map((swapped) => swapped.normalize('NFD').replace(/\p{M}/gu, ''))).toEqual(
      LETTERS,
    )
  })

  it('grows the text by about 40%, inside the markers', () => {
    expect(pseudoLocalize('a'.repeat(100))).toBe(`⟦${'á'.repeat(100)}${' ~'.repeat(20)}⟧`)
  })

  it('keeps placeholders and inline tags byte-for-byte, and pads for the text alone', () => {
    expect(pseudoLocalize('Delete {{count}} <strong>blocks</strong> from {{ title }}<m0/>')).toBe(
      '⟦Ḋéĺéţé {{count}} <strong>ḃĺóçķš</strong> ḟŕóṁ {{ title }}<m0/> ~ ~ ~ ~⟧',
    )
  })
})

describe('the en-XA catalog', () => {
  const en = i18n.getResourceBundle(DEFAULT_LOCALE, 'translation') as Record<string, string>

  // A key it lacks would fall back to unmarked English and read as a hardcoded string.
  it('carries every English key', () => {
    expect(Object.keys(enXA)).toEqual(Object.keys(en))
  })

  it('pseudo-localizes the English value', () => {
    expect(enXA['settings.languageLabel']).toBe('⟦Ĺáñğúáğé ~ ~⟧')
  })

  it('keeps every ENGLISH_IN_EVERY_LOCALE value English', () => {
    expect(ENGLISH_IN_EVERY_LOCALE.map((key) => enXA[key])).toEqual(
      ENGLISH_IN_EVERY_LOCALE.map((key) => en[key]),
    )
  })
})
