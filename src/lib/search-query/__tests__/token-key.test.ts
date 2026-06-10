/**
 * #756 — `tokenKey` must be unique per token within one query.
 *
 * The parser only invalidates duplicate `due:` / `scheduled:` filters;
 * every other kind can legitimately appear twice with the same value
 * (`tag:#a tag:#a`). Keys are therefore suffixed with the token's start
 * column (`span[0]`) — spans never overlap, so two tokens in the same
 * query can never collide.
 */

import { describe, expect, it } from 'vitest'

import type { FilterToken } from '../types'
import { tokenKey } from '../types'

describe('tokenKey', () => {
  it('disambiguates duplicate value tokens by start column', () => {
    const a: FilterToken = { kind: 'tag', value: 'urgent', span: [0, 11] }
    const b: FilterToken = { kind: 'tag', value: 'urgent', span: [12, 23] }
    expect(tokenKey(a)).not.toBe(tokenKey(b))
  })

  it('disambiguates duplicate prop tokens by start column', () => {
    const a: FilterToken = { kind: 'prop', key: 'status', value: 'done', span: [0, 17] }
    const b: FilterToken = { kind: 'prop', key: 'status', value: 'done', span: [18, 35] }
    expect(tokenKey(a)).not.toBe(tokenKey(b))
  })

  it('disambiguates duplicate date tokens by start column', () => {
    const a: FilterToken = {
      kind: 'due',
      raw: 'today',
      value: { kind: 'named', name: 'today' },
      span: [0, 9],
    }
    const b: FilterToken = {
      kind: 'due',
      raw: 'today',
      value: { kind: 'named', name: 'today' },
      span: [10, 19],
    }
    expect(tokenKey(a)).not.toBe(tokenKey(b))
  })

  it('disambiguates duplicate invalid tokens by start column', () => {
    const a: FilterToken = { kind: 'invalid', source: 'path:[x', error: 'bad', span: [0, 7] }
    const b: FilterToken = { kind: 'invalid', source: 'path:[x', error: 'bad', span: [8, 15] }
    expect(tokenKey(a)).not.toBe(tokenKey(b))
  })

  it('produces all-distinct keys across a mixed-token query', () => {
    const tokens: FilterToken[] = [
      { kind: 'tag', value: 'a', span: [0, 5] },
      { kind: 'tag', value: 'a', span: [6, 11] },
      { kind: 'pathInclude', value: 'J/*', span: [12, 20] },
      { kind: 'state', value: 'TODO', span: [21, 31] },
      { kind: 'notProp', key: 'k', value: 'v', span: [32, 44] },
      {
        kind: 'scheduled',
        raw: '>=2026-01-01',
        value: { kind: 'op', op: '>=', date: '2026-01-01' },
        span: [45, 67],
      },
    ]
    const keys = tokens.map(tokenKey)
    expect(new Set(keys).size).toBe(tokens.length)
  })

  it('still distinguishes different values at the same kind', () => {
    const a: FilterToken = { kind: 'tag', value: 'a', span: [0, 5] }
    const b: FilterToken = { kind: 'tag', value: 'b', span: [0, 5] }
    expect(tokenKey(a)).not.toBe(tokenKey(b))
  })
})
