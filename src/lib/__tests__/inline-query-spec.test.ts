/**
 * Round-trip + back-compat coverage for the structured inline-query payload
 * (`v2:<base64url(JSON)>`). The payload must survive the markdown serializer's
 * escape set and must NEVER hijack a legacy text query (decode returns null).
 */

import { describe, expect, it } from 'vitest'

import {
  type InlineQuerySpec,
  decodeInlineQueryPayload,
  encodeInlineQueryPayload,
  INLINE_QUERY_V2_PREFIX,
  isInlineQueryV2,
} from '../inline-query-spec'
import type { FilterExpr } from '../tauri'

const NESTED: FilterExpr = {
  type: 'Or',
  children: [
    { type: 'Leaf', primitive: { type: 'Priority', values: ['high'] } },
    {
      type: 'And',
      children: [
        { type: 'Leaf', primitive: { type: 'Tag', tag: 'T1' } },
        { type: 'Not', child: { type: 'Leaf', primitive: { type: 'State', values: ['done'] } } },
      ],
    },
  ],
}

describe('inline-query-spec', () => {
  it('round-trips a nested filter (list mode)', () => {
    const spec: InlineQuerySpec = { filter: NESTED, table: false }
    const decoded = decodeInlineQueryPayload(encodeInlineQueryPayload(spec))
    expect(decoded).toEqual(spec)
  })

  it('round-trips the table flag', () => {
    const spec: InlineQuerySpec = { filter: NESTED, table: true }
    const decoded = decodeInlineQueryPayload(encodeInlineQueryPayload(spec))
    expect(decoded?.table).toBe(true)
  })

  it('round-trips unicode property values', () => {
    const filter: FilterExpr = {
      type: 'Leaf',
      primitive: {
        type: 'HasProperty',
        key: 'café',
        predicate: { type: 'Eq', value: { type: 'Text', value: 'naïve ☕ 日本' } },
      },
    }
    const decoded = decodeInlineQueryPayload(encodeInlineQueryPayload({ filter, table: false }))
    expect(decoded?.filter).toEqual(filter)
  })

  it('emits a markdown-safe alphabet (no \\ * ` ~ = [ ] # + /)', () => {
    const payload = encodeInlineQueryPayload({ filter: NESTED, table: true })
    expect(payload.startsWith(INLINE_QUERY_V2_PREFIX)).toBe(true)
    const body = payload.slice(INLINE_QUERY_V2_PREFIX.length)
    // base64url body: only A–Z a–z 0–9 - _
    expect(body).toMatch(/^[A-Za-z0-9\-_]+$/)
  })

  it('returns null for a legacy text payload (back-compat)', () => {
    expect(decodeInlineQueryPayload('tag:work')).toBeNull()
    expect(decodeInlineQueryPayload('property:context=@office')).toBeNull()
    expect(decodeInlineQueryPayload('type:backlinks target:01ABC')).toBeNull()
    expect(isInlineQueryV2('tag:work')).toBe(false)
  })

  it('returns null for a corrupt v2 payload instead of throwing', () => {
    expect(decodeInlineQueryPayload('v2:!!!not-base64!!!')).toBeNull()
    expect(decodeInlineQueryPayload('v2:')).toBeNull()
    // Valid base64url of JSON that lacks a `filter` field.
    const noFilter = encodeInlineQueryPayload({ filter: NESTED, table: false }).replace(/^v2:/, '')
    // Sanity: the well-formed one decodes; a truncated one does not.
    expect(decodeInlineQueryPayload(`v2:${noFilter}`)).not.toBeNull()
    expect(decodeInlineQueryPayload(`v2:${noFilter.slice(0, 4)}`)).toBeNull()
  })

  it('recognises the v2 marker', () => {
    expect(isInlineQueryV2(encodeInlineQueryPayload({ filter: NESTED, table: false }))).toBe(true)
  })
})
