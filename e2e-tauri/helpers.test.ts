// VITEST tests for the pure parts of `helpers.ts`; `wdio.conf.ts` runs only
// `*.e2e.ts`. See `visibility-probe.test.ts` for why they live here.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { dataDirFromEnviron, distinctKeyChunks } from './helpers'

describe('distinctKeyChunks', () => {
  it('splits an adjacent repeat, so `[[` goes out as two calls', () => {
    expect(distinctKeyChunks('[[wdio-rival')).toEqual(['[', '[wdio-r', 'ival'])
  })

  it('puts each space after the first in a later call', () => {
    expect(distinctKeyChunks('zap of ink')).toEqual(['zap of', ' ink'])
  })

  it('returns no chunk for empty text', () => {
    expect(distinctKeyChunks('')).toEqual([])
  })

  it('types every character once, with no character twice in one call', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const chunks = distinctKeyChunks(text)
        expect(chunks.join('')).toBe(text)
        for (const chunk of chunks) {
          expect(new Set(chunk).size).toBe(Array.from(chunk).length)
        }
      }),
    )
  })
})

describe('dataDirFromEnviron', () => {
  it('reads AGARIC_DATA_DIR out of the NUL-separated entries', () => {
    const environ =
      'HOME=/root\0AGARIC_DATA_DIR=/tmp/agaric-wdio-vault-x/vault\0AGARIC_E2E_SANDBOX=1\0'
    expect(dataDirFromEnviron(environ)).toBe('/tmp/agaric-wdio-vault-x/vault')
  })

  it('does not take a variable whose name only ends in AGARIC_DATA_DIR', () => {
    expect(dataDirFromEnviron('OLD_AGARIC_DATA_DIR=/elsewhere\0HOME=/root\0')).toBeNull()
  })
})
