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
 * runs the same cases in `group_token_tests`. The call site — `rawRows`
 * appending them for the one command whose `WIRE` entry sets `groups: true` —
 * is pinned by the last two.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  CONFORMANCE_SPACE_ID,
  groupTokens,
  runQuerySteps,
  stampMockSpace,
} from '@/lib/tauri-mock/__tests__/conformance-query'
import { blocks, makeBlock, properties } from '@/lib/tauri-mock/seed'

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

/**
 * The CALL SITE, not just the projector: a grammar tested in isolation and
 * never wired into `rawRows` is a half-covered pair — exactly what item 2 is
 * about, one level down.
 */
describe('runQuerySteps records the grouped payload', () => {
  // A FLAT step reads real seed rows, so the two cases below are a genuine
  // pair: the grouped one is non-empty because the concatenation contributes,
  // the flat one is non-empty because the flat projection still does.
  beforeEach(() => {
    blocks.clear()
    properties.clear()
    blocks.set('P1', makeBlock('P1', 'page', 'Page One', null, 0))
    blocks.set('C1', makeBlock('C1', 'content', 'A child', 'P1', 1))
    stampMockSpace()
  })

  it('projects a grouped run_advanced_query step to non-empty rows', async () => {
    const out = await runQuerySteps(
      [
        {
          name: 'grouped_by_block_type',
          command: 'run_advanced_query',
          ordered: true,
          args: {
            request: {
              // The IMPORT, not the literal — as the flat test below does,
              // and as `conformance-query.ts`'s header requires (the id is
              // spelled once, there). The mock synthesises a bucket for any
              // space, so a drifted literal here would go on passing while
              // querying a space that does not exist: measured, this block
              // was green with `spaceId: '01NOSUCHSPACE00000000000X'`.
              spaceId: CONFORMANCE_SPACE_ID,
              limit: 100,
              groupBy: { key: { type: 'BlockType' } },
            },
          },
        },
      ],
      new Map(),
    )

    // The mock SYNTHESISES a single bucket keyed by the group-key type with an
    // empty member preview — which is exactly the divergence a grouped fixture
    // would now expose against the backend's real buckets, instead of both
    // stacks recording `[]` and agreeing on nothing.
    expect(out[0]?.rows).toEqual(['BlockType#count=1', 'BlockType->(none)'])
  })

  // The pair: a FLAT step must be byte-unchanged by the concatenation, or
  // every existing `run_advanced_query` expectation would have needed
  // re-authoring.
  //
  // It queries the SEEDED harness space, not an empty one. Pointed at a space
  // with no rows this assertion was `[] === []` — it passed identically with
  // the flat projection replaced by a hard-coded `const flat: string[] = []`,
  // i.e. it could not detect the very thing it claims ("the flat side is
  // untouched") being deleted outright. The recorded tokens below are the two
  // seeded blocks in canonical order, so dropping the flat projection — or
  // letting the grouped concatenation contribute to a flat response — reddens.
  it('leaves a flat run_advanced_query step untouched', async () => {
    const out = await runQuerySteps(
      [
        {
          name: 'flat_no_group',
          command: 'run_advanced_query',
          args: { request: { spaceId: CONFORMANCE_SPACE_ID, limit: 100 } },
        },
      ],
      new Map(),
    )

    expect(out[0]?.rows).toEqual(['C1', 'P1'])
  })
})
