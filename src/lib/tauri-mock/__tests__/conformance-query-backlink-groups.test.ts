/**
 * #4667 — the `GroupedBacklinkResponse` projection, TS half.
 *
 * `list_backlinks_grouped` and `list_unlinked_references` answer under
 * `groups[].blocks`, which neither the paged projection nor `groupTokens`
 * (bound to `run_advanced_query`'s bucket shape) could read, so both commands
 * sat in `NOT_YET_PINNED_READ` as "needs a projection extension". These pin
 * the token GRAMMAR, which has to agree byte-for-byte with
 * `backlink_groups_result` in `conformance_query.rs` (the Rust twin runs the
 * same three inputs in `backlink_group_token_tests`), and the CALL SITE
 * through `runQuerySteps`, so the projector is not a grammar nothing wires.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  CONFORMANCE_SPACE_ID,
  backlinkGroupTokens,
  runQuerySteps,
  stampMockSpace,
} from '@/lib/tauri-mock/__tests__/conformance-query'
import { blocks, makeBlock, properties } from '@/lib/tauri-mock/seed'

const BLOCK_TOKEN = {
  kind: 'id',
  idKey: 'id',
  attrKeys: ['parent_id', 'page_id', 'position', 'deleted_at'],
} as const

describe('backlinkGroupTokens mirrors the Rust backlink_groups_result projection', () => {
  it('projects a head per group and a member token per block, then the trailer', () => {
    expect(
      backlinkGroupTokens(
        {
          groups: [
            {
              page_id: 'P2',
              page_title: 'Alpha',
              truncated: false,
              blocks: [{ id: 'B1', parent_id: 'P2', page_id: 'P2', position: 1, deleted_at: null }],
            },
            {
              page_id: 'P1',
              page_title: 'Zulu',
              truncated: true,
              blocks: [
                { id: 'B2', parent_id: 'P1', page_id: 'P1', position: 1, deleted_at: null },
                { id: 'B3', parent_id: 'B2', page_id: 'P1', position: 1, deleted_at: null },
              ],
            },
          ],
          next_cursor: 'abc',
          has_more: true,
          total_count: 3,
          filtered_count: 2,
          truncated: false,
        },
        BLOCK_TOKEN,
      ),
    ).toEqual([
      'P2#page_title=Alpha#truncated=false',
      'P2->B1#parent_id=P2#page_id=P2#position=1#deleted_at=null',
      'P1#page_title=Zulu#truncated=true',
      'P1->B2#parent_id=P1#page_id=P1#position=1#deleted_at=null',
      'P1->B3#parent_id=B2#page_id=P1#position=1#deleted_at=null',
      'filtered#count=2#truncated=false',
    ])
  })

  // The trailer is what keeps an empty answer comparable: without it an empty
  // `groups` and an absent one would both project to `[]`.
  it('still records the counts for an empty answer', () => {
    expect(
      backlinkGroupTokens(
        {
          groups: [],
          next_cursor: null,
          has_more: false,
          total_count: 0,
          filtered_count: 0,
          truncated: true,
        },
        BLOCK_TOKEN,
      ),
    ).toEqual(['filtered#count=0#truncated=true'])
  })

  it('keeps a group served with no rows visible, and renders a missing title as null', () => {
    expect(
      backlinkGroupTokens(
        {
          groups: [{ page_id: 'P1', page_title: null, truncated: false, blocks: [] }],
          filtered_count: 0,
          truncated: false,
        },
        BLOCK_TOKEN,
      ),
    ).toEqual([
      'P1#page_title=null#truncated=false',
      'P1->(none)',
      'filtered#count=0#truncated=false',
    ])
  })
})

/**
 * The CALL SITE, against the mock's own handlers. The seed is the fixture's
 * shape in miniature: an "Alpha" page created AFTER a "Zulu" one, a source
 * nested two levels under "Zulu", and a source on the target's own page —
 * each a decision `query_backlinks_grouped.json` pins against the backend.
 */
describe('runQuerySteps records the grouped backlink payload', () => {
  const id = (tail: string): string => '0'.repeat(26 - tail.length) + tail
  const TARGET = id('TGT')
  const ZULU = id('ZED')
  const ALPHA = id('ALF')
  const C1 = id('C1')
  const C2 = id('C2')
  const C3 = id('C3')
  const C4 = id('C4')
  const C5 = id('C5')
  const C6 = id('C6')
  const scope = { kind: 'active', space_id: CONFORMANCE_SPACE_ID }

  beforeEach(() => {
    blocks.clear()
    properties.clear()
    blocks.set(TARGET, makeBlock(TARGET, 'page', 'Target', null, 1))
    blocks.set(ZULU, makeBlock(ZULU, 'page', 'Zulu', null, 2))
    blocks.set(C1, makeBlock(C1, 'content', `links to [[${TARGET}]]`, ZULU, 1))
    // Nested under C1: `makeBlock` writes `page_id = parent_id`, the ROOT is
    // what the backend groups by.
    blocks.set(C3, { ...makeBlock(C3, 'content', `nested [[${TARGET}]]`, C1, 1), page_id: ZULU })
    blocks.set(ALPHA, makeBlock(ALPHA, 'page', 'Alpha', null, 3))
    blocks.set(C2, makeBlock(C2, 'content', `[[${TARGET}]]`, ALPHA, 1))
    blocks.set(C4, makeBlock(C4, 'content', `self [[${TARGET}]]`, TARGET, 1))
    blocks.set(C5, makeBlock(C5, 'content', 'plain Target mention', ZULU, 2))
    blocks.set(C6, makeBlock(C6, 'content', 'another plain Target mention', ALPHA, 2))
    stampMockSpace()
  })

  it('groups by root page, sorts groups by title, drops the self-reference, and pages over groups', async () => {
    const out = await runQuerySteps(
      [
        {
          name: 'all',
          command: 'list_backlinks_grouped',
          args: { blockId: TARGET, limit: 10, scope },
        },
        {
          name: 'page_1',
          command: 'list_backlinks_grouped',
          args: { blockId: TARGET, limit: 1, scope },
        },
        {
          name: 'page_2',
          command: 'list_backlinks_grouped',
          args: { blockId: TARGET, limit: 1, scope },
          cursor_from: 'page_1',
        },
      ],
      new Map(),
    )

    expect(out[0]).toMatchObject({
      rows: [
        `${ALPHA}#page_title=Alpha#truncated=false`,
        `${ALPHA}->${C2}#parent_id=${ALPHA}#page_id=${ALPHA}#position=1#deleted_at=null`,
        `${ZULU}#page_title=Zulu#truncated=false`,
        `${ZULU}->${C1}#parent_id=${ZULU}#page_id=${ZULU}#position=1#deleted_at=null`,
        `${ZULU}->${C3}#parent_id=${C1}#page_id=${ZULU}#position=1#deleted_at=null`,
        'filtered#count=3#truncated=false',
      ],
      has_more: false,
      total_count: 3,
      cursor: null,
    })
    expect(out[1]).toMatchObject({
      rows: [
        `${ALPHA}#page_title=Alpha#truncated=false`,
        `${ALPHA}->${C2}#parent_id=${ALPHA}#page_id=${ALPHA}#position=1#deleted_at=null`,
        'filtered#count=3#truncated=false',
      ],
      has_more: true,
      total_count: 3,
      cursor: 'v1:{deleted_at,id}',
    })
    // A cursor page answers both counts as 0 (#2201 item 1b).
    expect(out[2]).toMatchObject({
      rows: [
        `${ZULU}#page_title=Zulu#truncated=false`,
        `${ZULU}->${C1}#parent_id=${ZULU}#page_id=${ZULU}#position=1#deleted_at=null`,
        `${ZULU}->${C3}#parent_id=${C1}#page_id=${ZULU}#position=1#deleted_at=null`,
        'filtered#count=0#truncated=false',
      ],
      has_more: false,
      total_count: 0,
      cursor: null,
    })
  })

  // `blocks.content` is nullable and `cmp_group` sorts a `None` title LAST; a
  // cursor slot minted as `null` would decode to `''` and sort FIRST, re-serving
  // the group. The sentinel has to survive the round trip.
  it('sorts a titleless source page last and pages past it', async () => {
    const NAMELESS = id('NON')
    const C7 = id('C7')
    blocks.set(NAMELESS, makeBlock(NAMELESS, 'page', null, null, 4))
    blocks.set(C7, makeBlock(C7, 'content', 'a third Target mention', NAMELESS, 1))
    stampMockSpace()

    const out = await runQuerySteps(
      [
        {
          name: 'page_1',
          command: 'list_unlinked_references',
          args: { pageId: TARGET, limit: 2, scope },
        },
        {
          name: 'page_2',
          command: 'list_unlinked_references',
          args: { pageId: TARGET, limit: 2, scope },
          cursor_from: 'page_1',
        },
      ],
      new Map(),
    )

    expect(out[0]?.rows.filter((r) => !r.includes('->'))).toEqual([
      `${ALPHA}#page_title=Alpha#truncated=false`,
      `${ZULU}#page_title=Zulu#truncated=false`,
      'filtered#count=3#truncated=false',
    ])
    expect(out[0]).toMatchObject({ has_more: true, cursor: 'v1:{deleted_at,id}' })
    expect(out[1]).toMatchObject({
      rows: [
        `${NAMELESS}#page_title=null#truncated=false`,
        `${NAMELESS}->${C7}#parent_id=${NAMELESS}#page_id=${NAMELESS}#position=1#deleted_at=null`,
        'filtered#count=3#truncated=false',
      ],
      has_more: false,
    })
  })

  it('serves the plain mentions as unlinked references, recounting on every page, and none for a content-block id', async () => {
    const out = await runQuerySteps(
      [
        {
          name: 'unlinked',
          command: 'list_unlinked_references',
          args: { pageId: TARGET, limit: 10, scope },
        },
        {
          name: 'page_1',
          command: 'list_unlinked_references',
          args: { pageId: TARGET, limit: 1, scope },
        },
        {
          name: 'page_2',
          command: 'list_unlinked_references',
          args: { pageId: TARGET, limit: 1, scope },
          cursor_from: 'page_1',
        },
        {
          name: 'not_a_page',
          command: 'list_unlinked_references',
          args: { pageId: C1, limit: 10, scope },
        },
      ],
      new Map(),
    )

    const alpha = [
      `${ALPHA}#page_title=Alpha#truncated=false`,
      `${ALPHA}->${C6}#parent_id=${ALPHA}#page_id=${ALPHA}#position=2#deleted_at=null`,
    ]
    const zulu = [
      `${ZULU}#page_title=Zulu#truncated=false`,
      `${ZULU}->${C5}#parent_id=${ZULU}#page_id=${ZULU}#position=2#deleted_at=null`,
    ]
    expect(out[0]).toMatchObject({
      rows: [...alpha, ...zulu, 'filtered#count=2#truncated=false'],
      has_more: false,
      total_count: 2,
    })
    expect(out[1]).toMatchObject({
      rows: [...alpha, 'filtered#count=2#truncated=false'],
      has_more: true,
      total_count: 2,
      cursor: 'v1:{deleted_at,id}',
    })
    // Unlike the backlink reader, the unlinked one recounts on a cursor page —
    // `useUnlinkedReferences` reads both counts from the LAST page.
    expect(out[2]).toMatchObject({
      rows: [...zulu, 'filtered#count=2#truncated=false'],
      has_more: false,
      total_count: 2,
      cursor: null,
    })
    expect(out[3]).toMatchObject({ rows: ['filtered#count=0#truncated=false'], total_count: 0 })
  })
})
