/**
 * #3833 item 2 — the GROUPED projection of `run_advanced_query`, TS half.
 *
 * `AdvancedQueryResponse` has two exclusive modes: `groupBy` absent fills
 * `rows` and leaves `groups` empty, `groupBy` present fills `groups` and leaves
 * `rows` empty. Until this landed, both runners read only `rows`, so a grouped
 * step projected to `[]` on BOTH stacks — non-comparable, while the coverage
 * ratchet went on counting `run_advanced_query` as covered.
 *
 * These pin the token GRAMMAR, which is the half that has to agree
 * byte-for-byte with `group_tokens` in `conformance_query.rs`; the Rust twin
 * runs the same cases in `group_token_tests`.
 */

import { describe, expect, it } from 'vitest'

import { groupTokens } from '@/lib/tauri-mock/__tests__/conformance-query'

describe('groupTokens mirrors the Rust group_tokens projection', () => {
  it('contributes nothing for a flat response', () => {
    expect(groupTokens({ rows: [{ id: 'B1' }], groups: [] })).toEqual([])
    expect(groupTokens({ rows: [{ id: 'B1' }] })).toEqual([])
  })

  it('projects a bucket count and one token per preview member', () => {
    expect(
      groupTokens({
        rows: [],
        groups: [{ key: 'DONE', count: 2, members: [{ id: 'B1' }, { id: 'B4' }] }],
      }),
    ).toEqual(['DONE#count=2', 'DONE->B1', 'DONE->B4'])
  })

  // The mock's grouped path synthesises a single bucket with NO members, so
  // without this token that stub would collapse into a bare count and read as
  // agreement with a backend that served real preview rows.
  it('keeps a bucket with an empty preview visible', () => {
    expect(groupTokens({ groups: [{ key: 'none', count: 7, members: [] }] })).toEqual([
      'none#count=7',
      'none->(none)',
    ])
  })

  it('projects every bucket, in the order the response paged them', () => {
    expect(
      groupTokens({
        groups: [
          { key: 'page', count: 1, members: [{ id: 'B1' }] },
          { key: 'content', count: 1, members: [{ id: 'B2' }] },
        ],
      }),
    ).toEqual(['page#count=1', 'page->B1', 'content#count=1', 'content->B2'])
  })

  // #3833 item 2 (review) — `QueryGroup`'s FOURTH field. All three cells of
  // each result are recorded, so an operator answering in the wrong cell is
  // visible rather than normalised away.
  it('projects a bucket per-group aggregates', () => {
    expect(
      groupTokens({
        groups: [
          {
            key: 'DONE',
            count: 2,
            members: [],
            aggregates: [
              { op: 'count', value: null, count: 2 },
              { op: 'sum', value: 7.5, count: null },
            ],
          },
        ],
      }),
    ).toEqual(['DONE#count=2#agg0=count/null/2#agg1=sum/7.5/null', 'DONE->(none)'])
  })

  // The contract is "in the SAME order as the request's `aggregates`".
  it('does not project reordered aggregates alike', () => {
    const a = groupTokens({
      groups: [
        {
          key: 'k',
          count: 1,
          members: [],
          aggregates: [
            { op: 'count', count: 1 },
            { op: 'sum', value: 2 },
          ],
        },
      ],
    })
    const b = groupTokens({
      groups: [
        {
          key: 'k',
          count: 1,
          members: [],
          aggregates: [
            { op: 'sum', value: 2 },
            { op: 'count', count: 1 },
          ],
        },
      ],
    })
    expect(a).not.toEqual(b)
  })

  // The SAME sentinel `propertyToken` falls back to, so the coverage test's
  // sentinel-leak guard (#3833 items 9/10) already covers this projection.
  it('records the shared sentinel for a bucket with no key', () => {
    expect(groupTokens({ groups: [{ count: 1, members: [] }] })).toEqual([
      '<missing-key>#count=1',
      '<missing-key>->(none)',
    ])
  })

  it('reads nothing out of a non-array or absent groups field', () => {
    expect(groupTokens({ groups: null })).toEqual([])
    expect(groupTokens(null)).toEqual([])
    expect(groupTokens({})).toEqual([])
  })
})
