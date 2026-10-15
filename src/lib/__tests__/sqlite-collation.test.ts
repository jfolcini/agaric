import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { compareUtf8Bytes } from '../sqlite-collation'

const encoder = new TextEncoder()

/** SQLite's `BINARY` order: a memcmp of the UTF-8 encodings. */
function memcmpUtf8(a: string, b: string): number {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
  }
  return x.length - y.length
}

// The units where UTF-16 order and UTF-8 order part ways: a surrogate pair
// against U+E000..U+FFFF, and lone surrogates, which encode as U+FFFD.
const UNITS = ['a', 'Z', 'é', '', '�', '\uD800', '\uDC00', '\u{1F600}', '\u{10FFFF}']

describe('compareUtf8Bytes', () => {
  it('agrees in sign with a memcmp of the UTF-8 encodings', () => {
    const text = fc.array(fc.constantFrom(...UNITS), { maxLength: 4 }).map((u) => u.join(''))
    fc.assert(
      fc.property(text, text, (a, b) => {
        expect(Math.sign(compareUtf8Bytes(a, b))).toBe(Math.sign(memcmpUtf8(a, b)))
      }),
    )
  })
})
