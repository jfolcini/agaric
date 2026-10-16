// VITEST tests for the pure parts of `helpers.ts`; `wdio.conf.ts` runs only
// `*.e2e.ts`. See `visibility-probe.test.ts` for why they live here.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { distinctKeyChunks } from './helpers'

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
