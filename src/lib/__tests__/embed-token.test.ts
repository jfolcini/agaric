/**
 * `{{embed …}}` token parsing (#4550).
 *
 * The failure these guard against: a sloppy parse either misses the token
 * (the block renders literal `{{embed ((X))}}` text, i.e. the feature is
 * silently absent) or over-matches, so a block that merely mentions the
 * syntax mid-sentence is taken over by a block-level container the user
 * never asked for.
 */

import { describe, expect, it } from 'vitest'

import { buildEmbedToken, parseEmbedToken } from '@/lib/embed-token'

describe('parseEmbedToken', () => {
  it('accepts both delimiter forms', () => {
    expect(parseEmbedToken('{{embed ((01H0000000000000000000000))}}')).toEqual({
      targetId: '01H0000000000000000000000',
    })
    expect(parseEmbedToken('{{embed [[01H0000000000000000000000]]}}')).toEqual({
      targetId: '01H0000000000000000000000',
    })
  })

  it('tolerates surrounding and inner whitespace', () => {
    expect(parseEmbedToken('  {{embed  ((ABC)) }}  ')).toEqual({ targetId: 'ABC' })
  })

  it('rejects anything that is not the block’s entire content', () => {
    // The `{{query …}}` precedent: the whole block is taken over by the
    // render, so a mid-sentence mention must stay text.
    expect(parseEmbedToken('see {{embed ((ABC))}} for context')).toBeNull()
    expect(parseEmbedToken('{{embed ((ABC))}} trailing')).toBeNull()
  })

  it('rejects half-typed and malformed tokens', () => {
    expect(parseEmbedToken('{{embed ((ABC))')).toBeNull()
    expect(parseEmbedToken('{{embed }}')).toBeNull()
    expect(parseEmbedToken('{{embed ((  ))}}')).toBeNull()
    expect(parseEmbedToken('{{embed ((A B))}}')).toBeNull()
    expect(parseEmbedToken('{{embed [[ABC))}}')).toBeNull()
  })

  it('does not confuse an embed with a query block', () => {
    expect(parseEmbedToken('{{query todo}}')).toBeNull()
  })

  it('handles null / undefined / empty content', () => {
    expect(parseEmbedToken(null)).toBeNull()
    expect(parseEmbedToken(undefined)).toBeNull()
    expect(parseEmbedToken('')).toBeNull()
  })

  it('round-trips what buildEmbedToken writes', () => {
    const id = '01HZZZZZZZZZZZZZZZZZZZZZZZ'
    expect(parseEmbedToken(buildEmbedToken(id))).toEqual({ targetId: id })
  })
})
