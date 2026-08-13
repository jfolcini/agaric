/**
 * #3837 — `run_advanced_query` `sort` handling + full-text narrowing.
 *
 * Companion to `advanced-query-filter-expr.test.ts` (structural `FilterExpr`
 * interpretation + the `b.id DESC` default keyset). This file pins the two
 * divergences that default covered nothing for:
 *
 *  1. `request.sort` was silently ignored (`id DESC` regardless of what the
 *     request asked for).
 *  2. `request.fulltext` did no narrowing at all — a MATCH term returned the
 *     WHOLE structurally-filtered set, not the intersection.
 *
 * Every ordering assertion below is constructed so the expected order
 * differs from BOTH the default `id DESC` keyset AND plain insertion/id-ASC
 * order — a fixture where the sorted order happens to coincide with either
 * would pass against the pre-fix `id DESC`-regardless code and prove
 * nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

const SPACE_A = 'SPACE_A'.padStart(26, '0')

/** Deterministic 26-char block id from a short numeric-ish label. */
function id(label: string): string {
  return label.padStart(26, '0')
}

/** Reset every mock store to empty (mirrors the conformance harness). */
function clearMock(): void {
  seedBlocks()
  blocks.clear()
  properties.clear()
  propertyDefs.clear()
  opLog.length = 0
}

/** Stamp a block's `space` property on its owning page (what `fbqInSpace` reads). */
function setSpace(blockId: string, spaceId: string): void {
  if (!properties.has(blockId)) properties.set(blockId, new Map())
  properties.get(blockId)?.set('space', {
    key: 'space',
    value_text: null,
    value_num: null,
    value_date: null,
    value_ref: spaceId,
    value_bool: null,
  })
}

interface QueryResponse {
  rows: Array<Record<string, unknown>>
  hasMore: boolean
  nextCursor: string | null
  totalCount: number | null
}

function run(request: Record<string, unknown>): QueryResponse {
  return dispatch('run_advanced_query', {
    request: { spaceId: SPACE_A, ...request },
  }) as QueryResponse
}

function orderedIds(request: Record<string, unknown>): string[] {
  return run(request).rows.map((r) => r['id'] as string)
}

describe('run_advanced_query — request.sort', () => {
  const PAGE = id('A0')
  // Ids ascending: LOW < MID < HIGH. Neither ascending nor descending id
  // order will match the position-sorted order asserted below.
  const LOW = id('10')
  const MID = id('20')
  const HIGH = id('30')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    // Insert in id order; positions are scrambled relative to it.
    const rows: Array<[string, number]> = [
      [LOW, 20],
      [MID, 5],
      [HIGH, 10],
    ]
    for (const [blockId, position] of rows) {
      const b = makeBlock(blockId, 'text', null, PAGE, position)
      b['page_id'] = PAGE
      b['position'] = position
      blocks.set(blockId, b)
    }
  })

  it('honours an explicit Position sort (ASC) — not id DESC, not insertion order', () => {
    const filter = { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } }
    // Position ASC: MID(5), HIGH(10), LOW(20).
    expect(
      orderedIds({ filter, sort: [{ source: { type: 'Column', name: 'position' } }] }),
    ).toEqual([MID, HIGH, LOW])
    // Proves the sort key is actually driving the order: the default (no
    // `sort`) keyset over the SAME rows is `id DESC` — a different
    // permutation — and insertion/id-ASC order (LOW, MID, HIGH) is a third.
    expect(orderedIds({ filter })).toEqual([HIGH, MID, LOW])
  })

  it('honours desc:true on the sort key (Position DESC)', () => {
    // Position DESC: LOW(20), HIGH(10), MID(5) — the reverse of the ASC case
    // above, and still neither the default id-DESC nor insertion order.
    expect(
      orderedIds({
        filter: { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } },
        sort: [{ source: { type: 'Column', name: 'position' }, desc: true }],
      }),
    ).toEqual([LOW, HIGH, MID])
  })

  it('a nullable Position sorts NULL last regardless of direction', () => {
    // Deliberately NOT the numerically-smallest id in the fixture (LOW/MID/
    // HIGH range 10-30): a smallest-id block would land last under the
    // pre-fix `id DESC`-regardless code too, for the wrong reason, making
    // the assertion vacuous. id('25') sits strictly between MID and HIGH.
    const NULLPOS = id('25')
    const b = makeBlock(NULLPOS, 'text', null, PAGE, 1)
    b['page_id'] = PAGE
    b['position'] = null
    blocks.set(NULLPOS, b)
    const filter = { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } }

    expect(
      orderedIds({ filter, sort: [{ source: { type: 'Column', name: 'position' } }] }).at(-1),
    ).toBe(NULLPOS)
    expect(
      orderedIds({
        filter,
        sort: [{ source: { type: 'Column', name: 'position' }, desc: true }],
      }).at(-1),
    ).toBe(NULLPOS)
  })

  it('sorts by Priority (primary) then appends the id DESC tiebreak (secondary)', () => {
    // Two priority groups so the PRIMARY term actually discriminates (a
    // filter that pinned a single priority value would make the id
    // tiebreak the only thing visible, indistinguishable from plain id
    // DESC — vacuous). 'high' < 'low' lexically, so ASC priority puts the
    // high group first; H1/H2 tie within the high group and fall through
    // to the id DESC tiebreak.
    const H1 = id('42')
    const H2 = id('43')
    const L1 = id('44')
    for (const [blockId, priority] of [
      [H1, 'high'],
      [H2, 'high'],
      [L1, 'low'],
    ] as const) {
      const b = makeBlock(blockId, 'text', null, PAGE, 1)
      b['page_id'] = PAGE
      b['priority'] = priority
      blocks.set(blockId, b)
    }
    const rows = orderedIds({
      filter: { type: 'Leaf', primitive: { type: 'Priority', values: ['high', 'low'] } },
      sort: [{ source: { type: 'Column', name: 'priority' } }],
    })
    // NOT plain id DESC over the matched set (which would be [L1, H2, H1]).
    expect(rows).toEqual([H2, H1, L1])
  })

  it('a Title sort orders PAGE rows by content; non-page rows (null title) sort last', () => {
    clearMock()
    const P1 = id('50') // 'Zebra'
    const P2 = id('51') // 'Apple'
    const P3 = id('52') // 'Mango'
    const CHILD = id('53') // non-page, no title
    blocks.set(P1, makeBlock(P1, 'page', 'Zebra', null, 0))
    blocks.set(P2, makeBlock(P2, 'page', 'Apple', null, 1))
    blocks.set(P3, makeBlock(P3, 'page', 'Mango', null, 2))
    for (const p of [P1, P2, P3]) setSpace(p, SPACE_A)
    const child = makeBlock(CHILD, 'text', 'child content', P1, 0)
    child['page_id'] = P1
    blocks.set(CHILD, child)

    expect(orderedIds({ sort: [{ source: { type: 'Column', name: 'title' } }] })).toEqual([
      P2, // Apple
      P3, // Mango
      P1, // Zebra
      CHILD, // null title, NULLS LAST
    ])
  })

  it('rejects a Relevance sort key when the request carries no fulltext term', () => {
    expect(() => run({ sort: [{ source: { type: 'Relevance' } }] })).toThrow()
  })
})

describe('run_advanced_query — request.fulltext', () => {
  const PAGE = id('B0')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
  })

  it('narrows the matched SET to blocks whose content matches the term', () => {
    const HIT = id('60')
    const MISS = id('61')
    const hit = makeBlock(HIT, 'text', 'contains the needle somewhere', PAGE, 0)
    hit['page_id'] = PAGE
    blocks.set(HIT, hit)
    const miss = makeBlock(MISS, 'text', 'nothing relevant here', PAGE, 1)
    miss['page_id'] = PAGE
    blocks.set(MISS, miss)

    const unfiltered = orderedIds({}).toSorted()
    const narrowed = orderedIds({ fulltext: 'needle' })
    // The narrowed set is a STRICT SUBSET, proving real filtering happened
    // (not merely re-sorting the same rows).
    expect(unfiltered).toContain(MISS)
    expect(narrowed).toEqual([HIT])
    expect(narrowed).not.toEqual(unfiltered)
  })

  it('composes with a structural filter (MATCH ∩ FilterExpr)', () => {
    const HIT_HIGH = id('70') // matches term AND priority=high
    const HIT_LOW = id('71') // matches term, priority=low (excluded by filter)
    const MISS_HIGH = id('72') // priority=high, does not match term
    for (const [blockId, content, priority] of [
      [HIT_HIGH, 'needle in here', 'high'],
      [HIT_LOW, 'needle in here too', 'low'],
      [MISS_HIGH, 'no term here', 'high'],
    ] as const) {
      const b = makeBlock(blockId, 'text', content, PAGE, 0)
      b['page_id'] = PAGE
      b['priority'] = priority
      blocks.set(blockId, b)
    }
    const rows = orderedIds({
      fulltext: 'needle',
      filter: { type: 'Leaf', primitive: { type: 'Priority', values: ['high'] } },
    })
    expect(rows).toEqual([HIT_HIGH])
  })

  it('defaults to relevance-first ordering (approximated) when no explicit sort is given', () => {
    // Scores (length / occurrence-count, lower = better) are constructed so
    // the expected order is neither ascending nor descending id order — the
    // only way a 3-element permutation can prove the comparator is actually
    // reading the approximated rank rather than falling back to id. Ids
    // ascend BEST(81) < WORST_2(80)... deliberately NOT in score order: the
    // id assigned to each rank is chosen so the by-id permutations
    // ([id80,id81,id82] ascending / [id82,id81,id80] descending) are both
    // different from the by-score permutation asserted below.
    const BEST = id('81') // 'needle'                       len 6,  occ 1 -> score 6   (best)
    const MIDDLE = id('80') // 'needle xx'                  len 9,  occ 1 -> score 9
    const WORST = id('82') // 'needle ' + 'x'.repeat(20)     len 27, occ 1 -> score 27 (worst)
    const worst = makeBlock(WORST, 'text', `needle ${'x'.repeat(20)}`, PAGE, 0)
    worst['page_id'] = PAGE
    blocks.set(WORST, worst)
    const best = makeBlock(BEST, 'text', 'needle', PAGE, 1)
    best['page_id'] = PAGE
    blocks.set(BEST, best)
    const middle = makeBlock(MIDDLE, 'text', 'needle xx', PAGE, 2)
    middle['page_id'] = PAGE
    blocks.set(MIDDLE, middle)

    const byScore = [BEST, MIDDLE, WORST]
    expect(orderedIds({ fulltext: 'needle' })).toEqual(byScore)
    // Neither ascending nor descending id order produces this permutation.
    const byIdAsc = [MIDDLE, BEST, WORST] // id80 < id81 < id82
    expect(byScore).not.toEqual(byIdAsc)
    expect(byScore).not.toEqual(byIdAsc.toReversed())
  })

  it('an explicit Relevance sort key is honoured the same way as the implicit default', () => {
    const A = id('90')
    const B = id('91')
    const a = makeBlock(A, 'text', 'needle', PAGE, 0)
    a['page_id'] = PAGE
    blocks.set(A, a)
    const b = makeBlock(B, 'text', `needle ${'x'.repeat(20)}`, PAGE, 1)
    b['page_id'] = PAGE
    blocks.set(B, b)

    expect(orderedIds({ fulltext: 'needle', sort: [{ source: { type: 'Relevance' } }] })).toEqual([
      A,
      B,
    ])
  })
})

/**
 * `SORT_COLUMN_GETTERS.lastEdited` — the one getter in the closed `SortColumn`
 * set that the sort tests above never exercised, and the only one whose value
 * is DERIVED (`MAX(op_log.created_at)` scanned per row) rather than read
 * straight off the block.
 *
 * Op-log timestamps are written explicitly rather than through `pushOp`, which
 * stamps `new Date().toISOString()` — three ops pushed in a loop can land in
 * the same millisecond, which would make the expected order depend on the
 * machine's clock resolution.
 */
describe('run_advanced_query — request.sort by lastEdited', () => {
  const PAGE = id('B0')
  // Ids ascending: OLD < NEW < MIDDLE. The lastEdited order asserted below is
  // deliberately a permutation of neither id ASC nor id DESC.
  const OLD = id('B1')
  const NEW = id('B2')
  const MIDDLE = id('B3')
  const NEVER = id('B4')

  /** Append an op-log entry for `blockId` with an exact `created_at`. */
  function stampEdit(blockId: string, createdAt: string): void {
    opLog.push({
      device_id: 'mock-device',
      seq: opLog.length + 1,
      op_type: 'UpdateBlock',
      payload: JSON.stringify({ block_id: blockId }),
      created_at: createdAt,
    })
  }

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    for (const blockId of [OLD, NEW, MIDDLE, NEVER]) {
      const b = makeBlock(blockId, 'text', null, PAGE, 0)
      b['page_id'] = PAGE
      blocks.set(blockId, b)
    }
    // Edit order is NOT id order: NEW is the most recently edited.
    stampEdit(OLD, '2024-01-01T00:00:00.000Z')
    stampEdit(NEW, '2024-03-01T00:00:00.000Z')
    stampEdit(MIDDLE, '2024-02-01T00:00:00.000Z')
    // NEVER gets no op-log entry and no seeded stamp — `null`, which the
    // getter maps to the `''` sentinel.
  })

  const TEXT_ONLY = { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } }

  it('sorts by the derived op-log max, ascending — with the never-edited row first', () => {
    // ASC: '' (NEVER) < Jan (OLD) < Feb (MIDDLE) < Mar (NEW).
    expect(
      orderedIds({ filter: TEXT_ONLY, sort: [{ source: { type: 'Column', name: 'lastEdited' } }] }),
    ).toEqual([NEVER, OLD, MIDDLE, NEW])
    // The sort key is what drives this: the default keyset over the SAME rows
    // is `id DESC`, a different permutation, and id ASC is a third.
    expect(orderedIds({ filter: TEXT_ONLY })).toEqual([NEVER, MIDDLE, NEW, OLD])
  })

  it('sorts by the derived op-log max, descending', () => {
    // DESC: Mar (NEW), Feb (MIDDLE), Jan (OLD), then the '' sentinel LAST.
    expect(
      orderedIds({
        filter: TEXT_ONLY,
        sort: [{ source: { type: 'Column', name: 'lastEdited' }, desc: true }],
      }),
    ).toEqual([NEW, MIDDLE, OLD, NEVER])
  })

  it('takes the MAX op-log entry per row, not the first or last appended', () => {
    // OLD gains a LATER edit than NEW, appended after it — so a getter reading
    // the first matching entry, or simply the last appended one, would order
    // these differently from a true MAX.
    stampEdit(OLD, '2024-04-01T00:00:00.000Z')
    stampEdit(NEW, '2024-02-15T00:00:00.000Z')
    expect(
      orderedIds({
        filter: TEXT_ONLY,
        sort: [{ source: { type: 'Column', name: 'lastEdited' }, desc: true }],
      }),
    ).toEqual([OLD, NEW, MIDDLE, NEVER])
  })
})
