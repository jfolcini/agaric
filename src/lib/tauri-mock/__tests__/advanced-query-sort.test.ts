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

import { base64UrlToUtf8, utf8ToBase64Url } from '@/lib/base64url'
import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  type CursorKind,
  approximateFtsRank,
  compareEntryToCursor,
  cursorValueFor,
  foldForFtsIndex,
  matchesFtsIndex,
  stripForFts,
} from '@/lib/tauri-mock/handlers/search'
import {
  blockTags,
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
  blockTags.clear()
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

  /**
   * #3863 — `run_advanced_query`'s `LastEdited` sort key is
   * `COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), 0)`
   * (`agaric-store/src/query/engine.rs:229`) with NO other data source, so
   * ANY two op-log-free rows on the backend tie at the same sentinel
   * regardless of what else the mock knows about them.
   *
   * This case pins the TIE specifically (the `NEVER` row above only pins
   * "sorts at the sentinel", which a single row cannot distinguish from
   * "sorts by some other key that happens to be extremal"). It was originally
   * written against `pageLastModifiedAt`'s mock-only seeded-stamp fallback: a
   * `pageLastModified` entry dated between OLD's (Jan 1) and MIDDLE's (Feb 1)
   * edits made this row slot BETWEEN them, ordering by something the engine
   * cannot see. That map and that fallback no longer exist — the seed writes
   * real `op_log` rows instead (#3884 / #3898) — so an op-log-free row has
   * nothing left to sort by but the sentinel.
   */
  it('two op-log-free rows tie at the never-edited sentinel and are separated only by the id tiebreak', () => {
    const UNEDITED = id('B5')
    const uneditedBlock = makeBlock(UNEDITED, 'text', null, PAGE, 0)
    uneditedBlock['page_id'] = PAGE
    blocks.set(UNEDITED, uneditedBlock)

    // Engine-faithful ASC order: NEVER and UNEDITED both coalesce to the same
    // "no op-log activity" sentinel and TIE, decided only by the id DESC
    // tiebreak (UNEDITED's id `…B5` > NEVER's `…B4`, so UNEDITED sorts first
    // among the tied pair) — neither may land between OLD and MIDDLE.
    expect(
      orderedIds({ filter: TEXT_ONLY, sort: [{ source: { type: 'Column', name: 'lastEdited' } }] }),
    ).toEqual([UNEDITED, NEVER, OLD, MIDDLE, NEW])
  })
})

/**
 * #3863 — the keyset cursor's WIRE SHAPE. The engine's `QueryCursor`
 * (`agaric-store/src/query/engine.rs:141-196`) encodes `{ version, values }`
 * — one TAGGED `CursorValue` per resolved sort term, in ORDER BY order — as
 * URL-safe, unpadded base64 (`base64::URL_SAFE_NO_PAD`). Before the fix the
 * mock's cursor was `btoa(JSON.stringify({ id }))`: a DIFFERENT JSON shape
 * (no `version`, no per-term `values`) over the STANDARD base64 alphabet
 * (`+`/`/`/`=`-padded) — an opaque token that never round-trips cross-stack,
 * but whose byte shape a wire-fidelity assertion CAN observe.
 *
 * Decodes with a hand-rolled URL-safe-base64 reader deliberately independent
 * of the handler's own `decodeCursor` — asserting against the PRODUCTION
 * decoder would make this a tautology that passes even if both drifted
 * together from the engine's actual encoding.
 */
describe('run_advanced_query — cursor payload shape (#3863)', () => {
  const PAGE = id('C0')
  const LOW = id('C1')
  const MID = id('C2')
  const HIGH = id('C3')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    for (const [blockId, position] of [
      [LOW, 20],
      [MID, 5],
      [HIGH, 10],
    ] as const) {
      const b = makeBlock(blockId, 'text', null, PAGE, position)
      b['page_id'] = PAGE
      b['position'] = position
      blocks.set(blockId, b)
    }
  })

  const TEXT_ONLY = { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } }

  /** Independent URL-safe-no-pad base64 → JSON reader (see the module doc above). */
  function decodeCursorIndependently(cursor: string): Record<string, unknown> {
    let b64 = cursor.replaceAll('-', '+').replaceAll('_', '/')
    while (b64.length % 4 !== 0) b64 += '='
    return JSON.parse(atob(b64)) as Record<string, unknown>
  }

  it('encodes { version, values } — a tagged CursorValue per resolved sort term, not just { id }', () => {
    const page1 = run({
      filter: TEXT_ONLY,
      sort: [{ source: { type: 'Column', name: 'position' } }],
      limit: 1,
    })
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).not.toBeNull()
    const decoded = decodeCursorIndependently(page1.nextCursor as string)

    // Engine cursor schema: a version tag, not a bare `{ id }` object.
    expect(decoded['version']).toBe(1)
    expect(Array.isArray(decoded['values'])).toBe(true)
    const values = decoded['values'] as Array<Record<string, unknown>>
    // Two resolved terms: the explicit Position sort, then the appended id
    // DESC tiebreak (mirrors `resolve_sort` always terminating in `b.id`).
    expect(values).toHaveLength(2)
    // Position ASC's first row is MID (position 5) — its cursor value is
    // TAGGED as an Int (`CursorKind::Position`, `src-tauri/agaric-store/src/query/engine.rs:232`), not folded
    // into an untyped `{ id }` object.
    expect(values[0]).toEqual({ t: 'Int', v: 5 })
    // The trailing tiebreak term carries the id, TAGGED as Text
    // (`CursorKind::Id`, `src-tauri/agaric-store/src/query/engine.rs:220`).
    expect(values[1]).toEqual({ t: 'Text', v: MID })
  })

  it('still resumes pagination correctly under a non-id sort with the new cursor shape', () => {
    const page1 = run({
      filter: TEXT_ONLY,
      sort: [{ source: { type: 'Column', name: 'position' } }],
      limit: 2,
    })
    expect(page1.rows.map((r) => r['id'])).toEqual([MID, HIGH]) // Position ASC: 5, 10
    expect(page1.hasMore).toBe(true)

    const page2 = run({
      filter: TEXT_ONLY,
      sort: [{ source: { type: 'Column', name: 'position' } }],
      limit: 2,
      cursor: page1.nextCursor,
    })
    expect(page2.rows.map((r) => r['id'])).toEqual([LOW]) // position 20
    expect(page2.hasMore).toBe(false)
  })
})

/**
 * #3900 — resuming with a cursor minted under a DIFFERENT `sort` than the
 * current request's must not silently restart from row 0.
 *
 * Before the fix, the anchor id was read out of the CURRENT request's
 * resolved sort at `idTermIndex` — the slot `sortTerms.findIndex(t =>
 * t.column === 'Id')` lands on for THIS request, not the sort the cursor was
 * minted under. Adding a term shifts that index (`[Position, Id]` → id at
 * 1; `[Position, Priority, Id]` → id at 2), so the OLD cursor's 2-value
 * tuple has nothing at the NEW index-2 slot: `anchorValue` is `undefined`,
 * `anchorId` falls to `null`, and the handler falls back to `startIdx = 0` —
 * a full restart that RE-DELIVERS the row `page1` already returned.
 *
 * The fixture is built so `R2`/`R3` decide entirely on `position` (distinct
 * values, term 0 alone resolves them) and only the anchor row `R1` itself
 * ties on `position` and has to fall through to the stale `priority` slot —
 * `R1`'s `priority` is deliberately `!R1` (`!` sorts below every digit,
 * including the `0` every seeded ULID starts with) so that comparison
 * resolves `R1` as NOT-after-cursor, i.e. correctly excluded, regardless of
 * the exact ULID bytes.
 */
describe('run_advanced_query — cursor reused across a sort change (#3900)', () => {
  const PAGE = id('H0')
  const R1 = id('H1')
  const R2 = id('H2')
  const R3 = id('H3')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    for (const [blockId, position, priority] of [
      [R1, 5, '!R1'],
      [R2, 10, null],
      [R3, 15, null],
    ] as const) {
      const b = makeBlock(blockId, 'text', null, PAGE, position)
      b['page_id'] = PAGE
      b['position'] = position
      b['priority'] = priority
      blocks.set(blockId, b)
    }
  })

  const TEXT_ONLY = { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } }

  it('does not re-deliver the anchor row when a term is added to `sort` between pages', () => {
    // Page 1: `sort: [position]` (2 resolved terms: Position, Id-tiebreak).
    const page1 = run({
      filter: TEXT_ONLY,
      sort: [{ source: { type: 'Column', name: 'position' } }],
      limit: 1,
    })
    expect(page1.rows.map((r) => r['id'])).toEqual([R1])
    expect(page1.hasMore).toBe(true)

    // Page 2: `sort` gains a `priority` term (3 resolved terms: Position,
    // Priority, Id-tiebreak) — Id's index shifts from 1 to 2.
    const page2 = run({
      filter: TEXT_ONLY,
      sort: [
        { source: { type: 'Column', name: 'position' } },
        { source: { type: 'Column', name: 'priority' } },
      ],
      limit: 10,
      cursor: page1.nextCursor,
    })
    // Pre-fix: R1 (page 1's row) reappears at the front of page 2. Fixed:
    // page 2 resumes past it.
    expect(page2.rows.map((r) => r['id'])).toEqual([R2, R3])
  })
})

/**
 * #3899 — `run_advanced_query` must REJECT a malformed cursor, mirroring
 * `QueryCursor::decode` (`agaric-store/src/query/engine.rs:180-195`)
 * returning `AppError::Validation` for bad base64 / invalid UTF-8 / invalid
 * JSON / an unsupported version, and the command propagating it to the
 * caller — rather than silently starting the query over from row 0.
 */
describe('run_advanced_query — malformed cursor is rejected, not silently restarted (#3899)', () => {
  const PAGE = id('I0')
  const ONLY = id('I1')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    const b = makeBlock(ONLY, 'text', null, PAGE, 0)
    b['page_id'] = PAGE
    blocks.set(ONLY, b)
  })

  it('throws a validation rejection on a cursor that is not valid base64url', () => {
    expect(() => run({ limit: 10, cursor: '!!!not-base64!!!' })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })

  it('throws a validation rejection on a cursor that decodes to non-JSON', () => {
    const notJson = utf8ToBase64Url('not json at all')
    expect(() => run({ limit: 10, cursor: notJson })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })

  it('throws a validation rejection on a cursor carrying an unsupported version', () => {
    const staleVersion = utf8ToBase64Url(JSON.stringify({ version: 99, values: [] }))
    expect(() => run({ limit: 10, cursor: staleVersion })).toThrow(
      expect.objectContaining({ kind: 'validation', message: expect.stringContaining('version') }),
    )
  })
})

/**
 * #3917 — the `groupBy` branch never reached any cursor decode at all: it
 * returned the synthetic empty-tail page for ANY non-null cursor, valid or
 * not. That is the same divergence class #3899 (immediately above) exists to
 * close, just on the other arm of this one command — after #3899/#3914 the
 * FLAT path throws a `validation` rejection on a malformed, foreign, or
 * version-stale cursor (mirroring `QueryCursor::decode`), while the grouped
 * path silently accepted garbage and returned `{ rows: [], groups: [],
 * hasMore: false }` regardless.
 *
 * The grouped arm decodes through {@link decodeGroupCursor} (NOT the flat
 * path's `decodeCursor`) — the backend's `run_grouped` decodes its own
 * `GroupCursor` (`src-tauri/agaric-store/src/query/engine.rs:1255-1270,1321-1324`), a DIFFERENT shape
 * (`{version,count,key}`) from the flat `QueryCursor`'s
 * (`{version,values}`). The three base64/UTF-8/JSON cases below don't depend
 * on which shape is expected, but the version and well-formed cases do, so
 * they exercise `{count,key}` payloads — and the shape-confusion cases at the
 * bottom pin that the two are genuinely not interchangeable.
 */
describe('run_advanced_query — groupBy cursor is rejected the same way the flat path is (#3917)', () => {
  const PAGE = id('J0')
  const ONLY = id('J1')
  const GROUP_BY = { key: { type: 'BlockType' } }

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    const b = makeBlock(ONLY, 'text', null, PAGE, 0)
    b['page_id'] = PAGE
    blocks.set(ONLY, b)
  })

  it('throws a validation rejection on a cursor that is not valid base64url', () => {
    expect(() => run({ limit: 10, groupBy: GROUP_BY, cursor: '!!!not-base64!!!' })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })

  it('throws a validation rejection on a cursor that decodes to non-JSON', () => {
    const notJson = utf8ToBase64Url('not json at all')
    expect(() => run({ limit: 10, groupBy: GROUP_BY, cursor: notJson })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })

  it('throws a validation rejection on a cursor carrying an unsupported version', () => {
    const staleVersion = utf8ToBase64Url(JSON.stringify({ version: 99, count: 0, key: 'text' }))
    expect(() => run({ limit: 10, groupBy: GROUP_BY, cursor: staleVersion })).toThrow(
      expect.objectContaining({ kind: 'validation', message: expect.stringContaining('version') }),
    )
  })

  it('still returns the synthetic empty-tail page for a WELL-FORMED GroupCursor (grouped pagination is a stub, not a rejection target)', () => {
    const wellFormed = utf8ToBase64Url(JSON.stringify({ version: 1, count: 3, key: 'text' }))
    const page = run({ limit: 10, groupBy: GROUP_BY, cursor: wellFormed }) as unknown as {
      rows: unknown[]
      groups: unknown[]
      hasMore: boolean
    }
    expect(page.rows).toEqual([])
    expect(page.groups).toEqual([])
    expect(page.hasMore).toBe(false)
  })

  it('a cursorless grouped request is unaffected: still synthesises one bucket', () => {
    const page = run({ limit: 10, groupBy: GROUP_BY }) as unknown as {
      groups: Array<{ count: number }>
    }
    expect(page.groups).toHaveLength(1)
    expect(page.groups[0]?.count).toBe(1)
  })

  // ── Shape confusion: `GroupCursor` (`{count,key}`) and `QueryCursor`
  // (`{values}`) are NOT interchangeable, on the backend or here. ──────────

  it('rejects a well-formed FLAT QueryCursor payload here — a group cursor has no `values` field', () => {
    // What the #3917 fix originally treated as "well-formed" for this arm
    // (it reused `decodeCursor`). The real backend's `GroupCursor::decode`
    // requires `count`/`key`; a payload carrying `values` instead has
    // neither, so it fails there too — this mock must reject it as well,
    // not accept it just because it happens to be valid JSON.
    const flatShaped = utf8ToBase64Url(JSON.stringify({ version: 1, values: [] }))
    expect(() => run({ limit: 10, groupBy: GROUP_BY, cursor: flatShaped })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })

  it('rejects a GroupCursor payload with the wrong field types', () => {
    const badTypes = utf8ToBase64Url(JSON.stringify({ version: 1, count: 'three', key: 5 }))
    expect(() => run({ limit: 10, groupBy: GROUP_BY, cursor: badTypes })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })

  // `decodeGroupCursor`'s own doc claims it mirrors serde's "deserialize the
  // whole struct — every field, typed — and only then compare versions"
  // ordering. `version` is declared FIRST in the real `GroupCursor`
  // (`src-tauri/agaric-store/src/query/engine.rs:1241-1247`), so a cursor missing it entirely fails
  // deserialization ("missing field `version`"), never reaching the version
  // COMPARISON at all — that comparison can only ever see a `version` serde
  // already parsed as a number. A cursor with no `version` field, or one of
  // the wrong TYPE, must therefore fail the same "malformed" way a cursor
  // missing `count`/`key` does, not surface as "unsupported version
  // undefined" (which claims the field was present and merely stale).
  it('a GroupCursor payload missing `version` entirely is malformed, not "version undefined"', () => {
    const noVersion = utf8ToBase64Url(JSON.stringify({ count: 3, key: 'text' }))
    expect(() => run({ limit: 10, groupBy: GROUP_BY, cursor: noVersion })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message: expect.not.stringContaining('undefined'),
      }),
    )
  })

  it('a GroupCursor payload with a wrongly-typed `version` is malformed, not a version mismatch', () => {
    // serde's `u8` field rejects a JSON string outright — this is a TYPE
    // failure, not a value the version-mismatch check ever gets to compare.
    const stringVersion = utf8ToBase64Url(JSON.stringify({ version: '1', count: 3, key: 'text' }))
    expect(() => run({ limit: 10, groupBy: GROUP_BY, cursor: stringVersion })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message: expect.not.stringContaining('unsupported version'),
      }),
    )
  })
})

/**
 * #3863 — cursor byte fidelity for values that are not plain ASCII.
 *
 * The cursor payload carries USER TEXT: the `Title` term is the raw page
 * title (`SORT_COLUMN_GETTERS.title` → `row.content`) and `Priority` is a
 * user-configurable label. The engine encodes
 * `URL_SAFE_NO_PAD.encode(json.as_bytes())` (`src-tauri/agaric-store/src/query/engine.rs:176`) — i.e. the
 * UTF-8 bytes of the JSON. `btoa` cannot do that: it throws
 * `InvalidCharacterError` above U+00FF and silently encodes the LATIN-1 byte
 * for U+0080–U+00FF, so the two failure modes are DIFFERENT and both are
 * asserted below:
 *
 *   - em dash (U+2014): `btoa` throws, and `dispatch` (`handlers.ts`) has no
 *     try/catch, so a raw DOMException escapes the IPC boundary instead of
 *     the mock's structured `validationRejection`.
 *   - `é` (U+00E9): `btoa` emits one 0xE9 byte where the engine emits the
 *     UTF-8 pair 0xC3 0xA9 — no throw, just cursor bytes that differ from
 *     the backend's for the same row.
 *
 * The expected string is computed from an INDEPENDENT base64url encoder over
 * `TextEncoder` bytes (below), not from the production helper, so this cannot
 * become a tautology that stays green if both drifted together.
 */
describe('run_advanced_query — cursor byte fidelity for non-ASCII values (#3863)', () => {
  const ZULU = id('D9') // 'Zulu' — sorts after every fixture title below

  beforeEach(() => {
    clearMock()
    blocks.set(ZULU, makeBlock(ZULU, 'page', 'Zulu', null, 9))
    setSpace(ZULU, SPACE_A)
  })

  /** URL-safe, unpadded base64 alphabet — `base64::URL_SAFE_NO_PAD`. */
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

  /**
   * Independent `URL_SAFE_NO_PAD.encode(json.as_bytes())`: UTF-8 encode, then
   * hand-rolled base64 over the raw bytes. Deliberately does NOT go through
   * `btoa`/`atob` or any production helper.
   */
  function rustCursorBytes(json: string): string {
    const bytes = new TextEncoder().encode(json)
    let out = ''
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i] ?? 0
      const b1 = bytes[i + 1]
      const b2 = bytes[i + 2]
      out += B64URL[b0 >> 2] ?? ''
      out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? ''
      if (b1 === undefined) break
      out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? ''
      if (b2 === undefined) break
      out += B64URL[b2 & 0x3f] ?? ''
    }
    return out
  }

  /** The exact bytes the engine would emit for a `[Title, Id]` cursor tuple. */
  function expectedTitleCursor(title: string, blockId: string): string {
    return rustCursorBytes(
      JSON.stringify({
        version: 1,
        values: [
          { t: 'Text', v: title },
          { t: 'Text', v: blockId },
        ],
      }),
    )
  }

  /** Seed one page and return the first page of a `title ASC`, `limit: 1` query. */
  function firstTitlePage(blockId: string, title: string): QueryResponse {
    blocks.set(blockId, makeBlock(blockId, 'page', title, null, 0))
    setSpace(blockId, SPACE_A)
    return run({ sort: [{ source: { type: 'Column', name: 'title' } }], limit: 1 })
  }

  it('encodes an above-U+00FF title (em dash) instead of throwing InvalidCharacterError', () => {
    const EM = id('D1')
    const TITLE = 'Q3 — Roadmap' // U+2014; sorts before 'Zulu'
    const page1 = firstTitlePage(EM, TITLE)
    expect(page1.rows.map((r) => r['id'])).toEqual([EM])
    expect(page1.hasMore).toBe(true)
    expect(page1.nextCursor).toBe(expectedTitleCursor(TITLE, EM))
  })

  it('encodes a U+0080–U+00FF title (é) as UTF-8, not as a single Latin-1 byte', () => {
    const ACCENT = id('D2')
    const TITLE = 'Café Notes' // U+00E9; sorts before 'Zulu'
    const page1 = firstTitlePage(ACCENT, TITLE)
    expect(page1.rows.map((r) => r['id'])).toEqual([ACCENT])
    expect(page1.nextCursor).toBe(expectedTitleCursor(TITLE, ACCENT))
  })

  it('round-trips a non-ASCII cursor back through the handler (page 2 resumes, not restarts)', () => {
    // Resume is what a wrong DECODER would break even with a right encoder:
    // a Latin-1 read of UTF-8 bytes yields a mojibake title and a mangled id.
    const EM = id('D1')
    const page1 = firstTitlePage(EM, 'Q3 — Roadmap')
    const page2 = run({
      sort: [{ source: { type: 'Column', name: 'title' } }],
      limit: 1,
      cursor: page1.nextCursor,
    })
    expect(page2.rows.map((r) => r['id'])).toEqual([ZULU])
    expect(page2.hasMore).toBe(false)
  })

  it('encodes an emoji title (astral plane, surrogate pair) as its 4 UTF-8 bytes', () => {
    const EMOJI = id('D3')
    const TITLE = '🎯 Goals' // U+1F3AF — outside the BMP, so a surrogate PAIR
    // JS string comparison is by UTF-16 code unit, and the leading surrogate
    // (0xD83C) sorts AFTER 'Z' (0x5A), so under title ASC the emoji row is
    // last and 'Zulu' is page 1's boundary row. Sort DESC instead, so the
    // emoji title is the one that actually reaches the cursor.
    const page1 = firstTitlePage(EMOJI, TITLE)
    expect(page1.rows.map((r) => r['id'])).toEqual([ZULU])
    const desc = run({
      sort: [{ source: { type: 'Column', name: 'title' }, desc: true }],
      limit: 1,
    })
    expect(desc.rows.map((r) => r['id'])).toEqual([EMOJI])
    expect(desc.nextCursor).toBe(expectedTitleCursor(TITLE, EMOJI))
  })

  /**
   * #3863 note 1 — `EngineRow::cursor_value` (`src-tauri/agaric-store/src/query/engine.rs:322`) reads the
   * COALESCE'd `last_edited: i64` and can only ever emit `CursorValue::Int`;
   * `CursorValue::Null` is UNREACHABLE for that column. The mock's
   * "no op-log activity" sentinel must therefore encode as the engine's
   * `Int(0)` — the value `COALESCE(…, 0)` actually produces — not as `Null`.
   *
   * The Int-vs-Text gap for a row that HAS op-log activity is the separate,
   * pre-existing ISO-string representation divergence documented on
   * `CursorKind`; only the sentinel is this change's own choice, and it has
   * an exact engine answer.
   */
  it('encodes the never-edited lastEdited sentinel as the engine Int(0), not Null', () => {
    const NEVER = id('E1')
    const b = makeBlock(NEVER, 'text', null, null, 0)
    b['page_id'] = ZULU
    blocks.set(NEVER, b)
    opLog.push({
      device_id: 'mock-device',
      seq: 1,
      op_type: 'UpdateBlock',
      payload: JSON.stringify({ block_id: ZULU }),
      created_at: '2024-05-01T00:00:00.000Z',
    })

    // ASC: the sentinel sorts first, so page 1's boundary row is NEVER.
    const page1 = run({
      sort: [{ source: { type: 'Column', name: 'lastEdited' } }],
      limit: 1,
    })
    expect(page1.rows.map((r) => r['id'])).toEqual([NEVER])
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(
            (page1.nextCursor as string).replaceAll('-', '+').replaceAll('_', '/') +
              '='.repeat((4 - ((page1.nextCursor as string).length % 4)) % 4),
          ),
          (c) => c.codePointAt(0) ?? 0,
        ),
      ),
    ) as { values: Array<Record<string, unknown>> }
    expect(decoded.values[0]).toEqual({ t: 'Int', v: 0 })
  })
})

/**
 * #3888 review note 3 — `run_advanced_query`'s `LastEdited` FILTER and its
 * `lastEdited` SORT must read the SAME column.
 *
 * #3863 pointed the sort getter at the raw `MAX(op_log.created_at)` scan but
 * left `metaRowMatchesExpr`'s `LastEdited` leaf on `row.lastModifiedAt`, i.e.
 * `pageLastModifiedAt` WITH the mock-only seeded fallback. The engine's
 * `compile_last_edited` (`agaric-store/src/filters/primitive.rs:1035-1052`)
 * compiles to the op-log MAX with the same COALESCE-to-epoch rule and has no
 * seed analogue, so the split let a seeded, op-log-free block pass a
 * `Rolling{30}` filter on a stamp the backend cannot see AND then sort at the
 * never-edited sentinel in the same response — where the engine would have
 * excluded it outright.
 *
 * `list_pages_with_metadata` was the last consumer of that fallback (#3884 /
 * #3898); it is now off it too, and the map itself is deleted, so the
 * "op-log-free" rows below are op-log-free full stop. The
 * `list_pages_with_metadata` counterpart of this block lives in
 * `pages-last-modified-op-log.test.ts`.
 */
describe('run_advanced_query — LastEdited filter reads the op-log, not the seed (#3888 note 3)', () => {
  const PAGE = id('G0')
  const UNEDITED = id('G1')
  const EDITED = id('G2')

  const rolling30 = {
    type: 'Leaf',
    primitive: { type: 'LastEdited', spec: { type: 'Rolling', days: 30 } },
  }

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    for (const blockId of [UNEDITED, EDITED]) {
      const b = makeBlock(blockId, 'text', null, PAGE, 0)
      b['page_id'] = PAGE
      blocks.set(blockId, b)
    }
    // UNEDITED: NO op-log activity — the engine sees only the epoch sentinel
    // for it, and (since #3884/#3898 deleted the `pageLastModified` map) so
    // does the mock, with nothing else left to consult.
    // EDITED: real op-log activity inside the window.
    opLog.push({
      device_id: 'mock-device',
      seq: 1,
      op_type: 'UpdateBlock',
      payload: JSON.stringify({ block_id: EDITED }),
      created_at: new Date().toISOString(),
    })
  })

  it('excludes an op-log-free block from Rolling{30} (the engine coalesces it to the epoch)', () => {
    expect(orderedIds({ filter: rolling30 })).not.toContain(UNEDITED)
  })

  it('still includes a block with real op-log activity inside the window', () => {
    expect(orderedIds({ filter: rolling30 })).toContain(EDITED)
  })

  it('includes the op-log-free block in OlderThan{30} — the epoch counts as old', () => {
    // The mirror of the Rolling case: the engine's COALESCE-to-epoch rule
    // makes "no op-log" OLD, not "unknown". Asserting only the Rolling side
    // would also pass if the filter had simply started dropping the row.
    const older = orderedIds({
      filter: {
        type: 'Leaf',
        primitive: { type: 'LastEdited', spec: { type: 'OlderThan', days: 30 } },
      },
    })
    expect(older).toContain(UNEDITED)
    expect(older).not.toContain(EDITED)
  })

  it('filters and sorts on one source: the row Rolling{30} keeps is not the one that ties at the sentinel', () => {
    // The whole point of note 3 — before the fix UNEDITED could appear in a
    // Rolling{30} response AND sort at the never-edited sentinel within it.
    const rows = run({
      filter: rolling30,
      sort: [{ source: { type: 'Column', name: 'lastEdited' } }],
    }).rows.map((r) => r['id'])
    expect(rows).toEqual([EDITED])
  })
})

/**
 * #3888 review note 4 — the `Rank` cursor value, the one tagged value the
 * #3863 tests left unpinned.
 *
 * Two separate things are asserted here and they are NOT the same claim:
 *
 *  - **The non-finite guard (a real defect).** `approximateFtsRank` returns
 *    `Number.POSITIVE_INFINITY` for a zero-occurrence row (`search.ts`).
 *    `JSON.stringify` has no Infinity literal and emits `null`, so the
 *    payload would be `{"t":"Real","v":null}` — which serde CANNOT
 *    deserialize into `CursorValue::Real(f64)`, i.e. a cursor the engine
 *    rejects outright rather than one that merely differs. The engine's own
 *    answer for "this row has no rank" is `Null`
 *    (`EngineRow::cursor_value`'s `self.rank.map_or(CursorValue::Null,
 *    CursorValue::Real)`, `src-tauri/agaric-store/src/query/engine.rs:322`), so that is what the guard emits.
 *    Unreachable through `run_advanced_query` — the MATCH narrowing
 *    (`matchesFtsIndex`) and the ranker fold the SAME `stripForFts` text with
 *    the SAME function, so a surviving row always has ≥1 occurrence — which is
 *    exactly why it is asserted against `cursorValueFor` directly.
 *
 *  - **Integral ranks (a documented representation difference, NOT fixed).**
 *    `JSON.stringify(10)` is `10` where `serde_json` writes a `f64` 10.0 as
 *    `10.0`. This is a byte difference only: serde's `f64` deserializer
 *    accepts a JSON integer, so a cursor minted either side still decodes to
 *    the same `Real(10.0)` and resumes at the same row. Pinned rather than
 *    "fixed" because emitting `10.0` from JS needs hand-built JSON for one
 *    cosmetic digit, and the epsilon band (`RANK_EPSILON = 1e-9`,
 *    `engine.rs`) means the value is never compared exactly anyway.
 */
describe('run_advanced_query — Rank cursor value (#3888 note 4)', () => {
  const PAGE = id('F0')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
  })

  it('tags a non-finite rank as the engine Null, not as an unparseable {"t":"Real","v":null}', () => {
    // `cursorValueFor`'s `Rank` branch, driven directly: the getter stands in
    // for `approximateFtsRank`'s zero-occurrence return. `JSON.parse(
    // JSON.stringify(...))` is the point — it is the wire form, not the
    // in-memory object, that has to survive serde.
    const term = {
      desc: false,
      get: () => Number.POSITIVE_INFINITY,
      column: 'Rank',
    } as unknown as Parameters<typeof cursorValueFor>[0]
    const onWire = JSON.parse(
      JSON.stringify(cursorValueFor(term, {} as Parameters<typeof cursorValueFor>[1])),
    ) as Record<string, unknown>
    expect(onWire).toEqual({ t: 'Null' })
  })

  it('emits an integral rank as a JSON integer — a byte difference from serde 10.0 that still decodes to Real(10.0)', () => {
    const HIT = id('F1')
    const OTHER = id('F2')
    // 'aa' folded length 2, one occurrence of 'aa' → rank 2/1 = 2 (integral).
    for (const [blockId, content] of [
      [HIT, 'aa'],
      [OTHER, 'aaaa'],
    ] as const) {
      const b = makeBlock(blockId, 'text', content, PAGE, 0)
      b['page_id'] = PAGE
      b['content'] = content
      blocks.set(blockId, b)
    }
    // Relevance ASC (lower = better): 'aa' scores 2/1 = 2, 'aaaa' scores
    // 4/2 = 2 as well, so the id DESC tiebreak decides — F2 first.
    const page1 = run({
      fulltext: 'aa',
      sort: [{ source: { type: 'Relevance' } }],
      limit: 1,
    })
    expect(page1.rows).toHaveLength(1)
    const cursorJson = new TextDecoder().decode(
      Uint8Array.from(
        atob(
          (page1.nextCursor as string).replaceAll('-', '+').replaceAll('_', '/') +
            '='.repeat((4 - ((page1.nextCursor as string).length % 4)) % 4),
        ),
        (c) => c.codePointAt(0) ?? 0,
      ),
    )
    // The RAW bytes, not the parsed value: `2` vs serde's `2.0` is invisible
    // after `JSON.parse`, and the raw form is what this pins.
    expect(cursorJson).toContain('{"t":"Real","v":2}')
    // …and the resume still works, which is the reason it stays a `2`.
    const page2 = run({
      fulltext: 'aa',
      sort: [{ source: { type: 'Relevance' } }],
      limit: 1,
      cursor: page1.nextCursor,
    })
    expect(page2.rows.map((r) => r['id'])).not.toEqual(page1.rows.map((r) => r['id']))
  })
})

/**
 * The `SortColumn` set is CLOSED. The mock resolves a key's getter by name, and
 * an object-literal index would resolve `constructor` / `valueOf` / `toString`
 * to an inherited `Object.prototype` method — truthy, so accepted and pushed as
 * a sort term. The engine rejects such a key at deserialization, so silently
 * accepting it is a mock-vs-engine divergence in the direction that matters:
 * the mock is MORE permissive than the thing it stands in for.
 *
 * Same hazard and same fix as the agenda group-header lookup in #3851.
 *
 * The observable consequence is deliberately mild — a bogus getter returns the
 * same value for every row, so the `id DESC` tiebreak decides and the order
 * looks correct. That is exactly why it needs pinning: it fails silently.
 * These assert the order is the UNSORTED default, which is what "the bogus key
 * was ignored" means.
 */
describe('run_advanced_query — request.sort rejects non-column keys', () => {
  const PAGE = id('C0')
  const FIRST = id('C1')
  const SECOND = id('C2')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    // Positions ASCEND with id, so Position ASC ([FIRST, SECOND]) is the
    // OPPOSITE of the `id DESC` default ([SECOND, FIRST]). If the two
    // coincided, a wrongly-accepted sort term would be undetectable and every
    // assertion below would be vacuous.
    for (const [blockId, position] of [
      [FIRST, 1],
      [SECOND, 5],
    ] as Array<[string, number]>) {
      const b = makeBlock(blockId, 'text', null, PAGE, position)
      b['page_id'] = PAGE
      b['position'] = position
      blocks.set(blockId, b)
    }
  })

  const TEXT_ONLY = { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } }
  // Default keyset is `id DESC`, and the ids ascend, so this is SECOND, FIRST.
  // Position ASC would be the opposite order, which is what makes a wrongly
  // accepted sort term detectable at all.
  const DEFAULT_ORDER = [SECOND, FIRST]

  // Only `__proto__` is asserted, and that is deliberate. `constructor`,
  // `valueOf`, `toString` and `hasOwnProperty` were tried here first and all
  // four stayed GREEN against the unguarded object-literal lookup: they
  // resolve to a `Object.prototype` method whose return value compares EQUAL
  // for every row, so the `id DESC` tiebreak decides and "accepted but inert"
  // is indistinguishable from "ignored" through this seam. Keeping them would
  // have been four assertions that cannot fail. They are named here rather
  // than deleted silently, because the fact that they are unobservable is the
  // reason the guard is worth having: the engine REJECTS such a key, so the
  // mock accepting it is a real divergence that no black-box assertion over
  // row order can catch.
  it('ignores the inherited __proto__ key instead of sorting by it', () => {
    expect(
      orderedIds({
        filter: TEXT_ONLY,
        sort: [{ source: { type: 'Column', name: '__proto__' } }],
      }),
    ).toEqual(DEFAULT_ORDER)
  })

  it('ignores a non-Column source that carries a name', () => {
    expect(
      orderedIds({
        filter: TEXT_ONLY,
        sort: [{ source: { type: 'Aggregate', name: 'position' } }],
      }),
    ).toEqual(DEFAULT_ORDER)
  })

  it('still honours a genuine Column key, so the guard is not rejecting everything', () => {
    // Position ASC is the opposite of the default — proving the tests above
    // assert "ignored", not "sorting is broken for all keys".
    expect(
      orderedIds({ filter: TEXT_ONLY, sort: [{ source: { type: 'Column', name: 'position' } }] }),
    ).toEqual([FIRST, SECOND])
  })
})

/**
 * Drive a full keyset walk at `limit: 1`, returning every id delivered in
 * order — the shape a real `while (hasMore)` client has.
 *
 * `limit: 1` rather than a larger page on purpose: it puts a cursor boundary
 * between EVERY adjacent pair of rows, so a boundary-comparison defect cannot
 * hide inside a page. The `maxPages` cap THROWS rather than returning what it
 * collected, because "the walk never terminates" is one of the two failure
 * modes being pinned (a cursor that re-selects its own row re-delivers it
 * forever) and a silent truncation would read as a mere ordering mismatch.
 */
function pageAllIds(request: Record<string, unknown>, maxPages = 12): string[] {
  const ids: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const response: QueryResponse = run({
      ...request,
      limit: 1,
      ...(cursor === null ? {} : { cursor }),
    })
    ids.push(...response.rows.map((r) => r['id'] as string))
    if (!response.hasMore || response.nextCursor === null) return ids
    cursor = response.nextCursor
  }
  throw new Error(`keyset walk did not terminate after ${maxPages} pages: [${ids.join(', ')}]`)
}

/**
 * #3914 review (blocking) — a boundary row must compare EQUAL to the cursor
 * minted FROM it, in every column. The keyset resume is a lexicographic
 * "strictly after the cursor tuple" test, so the row that minted the cursor
 * has to land at exactly 0; anything else either skips rows (negative) or
 * re-delivers the anchor forever (positive).
 *
 * `lastEdited` broke that invariant because encode and decode were not
 * inverses: `SORT_COLUMN_GETTERS.lastEdited` yields the STRING sentinel `''`
 * for an op-log-free row, `cursorValueFor` deliberately encodes it as the
 * engine's `Int(0)` (see that function's doc — `Null` is unreachable on the
 * engine for this column), and the decode side turned that back into the
 * NUMBER `0`. `compareSortValue('', 0, …)` then took the string branch and
 * compared `''` against `'0'` — never 0.
 *
 * TWO sentinel rows is the minimum fixture that can fail. With a single
 * never-edited row the walk still terminates correctly in both directions:
 * ASC lands past it on the edited row (nothing was skipped because there was
 * nothing between), and DESC has no second sentinel to be stuck ahead of. The
 * pre-existing sentinel test therefore covered the encoded BYTES and never
 * asked for page 2.
 *
 * Both directions are asserted because the defect splits by sign, and the two
 * halves look nothing alike:
 *   - ASC  — the sentinel rows compare -1 ("before the cursor"), so
 *     `findIndex` runs past ALL of them onto the edited row: SENT_LO is
 *     silently dropped from the result set.
 *   - DESC — the same -1 is flipped to +1, so `findIndex` returns the
 *     cursor's OWN row: page 3 repeats page 2 with an identical cursor and a
 *     `while (hasMore)` client never terminates.
 */
describe('run_advanced_query — keyset walk over repeated never-edited rows (#3914 review)', () => {
  const PAGE = id('J0')
  // Ids ASCEND: EDITED < SENT_LO < SENT_HI. The resolved sort always ends in
  // an `id DESC` tiebreak, so the two sentinel rows (tied at `''`) come back
  // HIGH-then-LOW, and neither expected order below coincides with insertion
  // order or with plain id DESC.
  const EDITED = id('J1')
  const SENT_LO = id('J2')
  const SENT_HI = id('J3')

  const BY_LAST_EDITED = { source: { type: 'Column', name: 'lastEdited' } }
  // Excludes the fixture's own page block, which is itself op-log-free and
  // would otherwise join the sentinel group as a third tied row.
  const TEXT_ONLY = { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } }

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    for (const blockId of [EDITED, SENT_LO, SENT_HI]) {
      const b = makeBlock(blockId, 'text', null, PAGE, 0)
      b['page_id'] = PAGE
      blocks.set(blockId, b)
    }
    // ONLY `EDITED` has op-log activity; the other two sit at the mock's
    // "no op-log" sentinel, which is what `rawOpLogLastEditedAt` reads.
    opLog.push({
      device_id: 'mock-device',
      seq: 1,
      op_type: 'UpdateBlock',
      payload: JSON.stringify({ block_id: EDITED }),
      created_at: '2024-01-01T00:00:00.000Z',
    })
  })

  it('delivers every row exactly once walking lastEdited ASC one page at a time', () => {
    // The un-paginated order, so the walk below is compared against this
    // command's OWN answer rather than against a hand-guessed permutation.
    expect(orderedIds({ filter: TEXT_ONLY, sort: [BY_LAST_EDITED] })).toEqual([
      SENT_HI,
      SENT_LO,
      EDITED,
    ])
    expect(pageAllIds({ filter: TEXT_ONLY, sort: [BY_LAST_EDITED] })).toEqual([
      SENT_HI,
      SENT_LO,
      EDITED,
    ])
  })

  it('delivers every row exactly once walking lastEdited DESC one page at a time', () => {
    const desc = { filter: TEXT_ONLY, sort: [{ ...BY_LAST_EDITED, desc: true }] }
    expect(orderedIds(desc)).toEqual([EDITED, SENT_HI, SENT_LO])
    expect(pageAllIds(desc)).toEqual([EDITED, SENT_HI, SENT_LO])
  })
})

/**
 * #3914 review note 3 — what the "safe degrade" for a SHORT cursor actually
 * degrades to, asserted in both directions instead of asserted in a comment.
 *
 * `compareEntryToCursor` is positional, mirroring the engine's own indexing
 * of `cursor.values[i]` against the CURRENT request's `terms[i]`. When the
 * current sort resolves to MORE terms than the cursor carries — a caller
 * adding a sort key between pages — the trailing slots read as `undefined`.
 * The engine has no behaviour to mirror here at all (`cursor.values[i]` is an
 * out-of-bounds panic in Rust), so the mock picks the NULL case.
 *
 * The consequence is NOT direction-split, which is worth pinning because it
 * looks like it should be: NULLS LAST is applied ahead of the `desc` flip
 * (`compareCursorValue`), so a missing slot is the GREATEST value either way.
 * Every row that ties the cursor on the terms it does carry therefore
 * compares "before the cursor" and is dropped from the resumed page, in ASC
 * and DESC alike. Rows that a carried term already resolves are untouched —
 * which is what keeps this a truncation rather than an empty page, and is why
 * both assertions below still return exactly one row.
 *
 * The cursor is hand-built rather than minted by a first page: a real page-1
 * cursor always carries a value per term of the sort it was minted under, so
 * the short case is only reachable by changing the sort, and building it
 * directly pins the degrade without also depending on which sort change
 * produced it.
 */
describe('run_advanced_query — a cursor SHORTER than the resolved sort truncates, both ways (#3914 review note 3)', () => {
  const PAGE = id('K0')
  const TIED_LO = id('K1')
  const TIED_HI = id('K2')
  const AFTER = id('K3')
  const BEFORE = id('K4')

  const TEXT_ONLY = { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } }
  const BY_POSITION = { source: { type: 'Column', name: 'position' } }

  /** A one-value cursor, where `[position, id]` resolves to TWO terms. */
  const SHORT_CURSOR = utf8ToBase64Url(JSON.stringify({ version: 1, values: [{ t: 'Int', v: 5 }] }))

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    for (const [blockId, position] of [
      [TIED_LO, 5],
      [TIED_HI, 5],
      [AFTER, 9],
      [BEFORE, 1],
    ] as Array<[string, number]>) {
      const b = makeBlock(blockId, 'text', null, PAGE, position)
      b['page_id'] = PAGE
      b['position'] = position
      blocks.set(blockId, b)
    }
  })

  it('ASC: drops the rows tied at the cursor position, keeps the strictly-greater one', () => {
    expect(orderedIds({ filter: TEXT_ONLY, sort: [BY_POSITION] })).toEqual([
      BEFORE,
      TIED_HI,
      TIED_LO,
      AFTER,
    ])
    // TIED_HI/TIED_LO tie on term 0 and fall through to the missing slot.
    expect(
      run({ filter: TEXT_ONLY, sort: [BY_POSITION], limit: 10, cursor: SHORT_CURSOR }).rows.map(
        (r) => r['id'],
      ),
    ).toEqual([AFTER])
  })

  it('DESC: drops the same tied rows — NULLS LAST is not flipped by desc', () => {
    const desc = { filter: TEXT_ONLY, sort: [{ ...BY_POSITION, desc: true }] }
    expect(orderedIds(desc)).toEqual([AFTER, TIED_HI, TIED_LO, BEFORE])
    // The mirror image of the ASC case: the tied pair is dropped again (not
    // re-delivered), and the row the DESC order puts strictly after the
    // cursor's position survives.
    expect(run({ ...desc, limit: 10, cursor: SHORT_CURSOR }).rows.map((r) => r['id'])).toEqual([
      BEFORE,
    ])
  })
})

/**
 * #3914 review note 1 — `decodeCursor` claims parity with `QueryCursor::decode`
 * (`agaric-store/src/query/engine.rs:180-195`) across all FOUR of its failure
 * modes, and invalid UTF-8 is the one that was not actually mirrored.
 *
 * `base64UrlToUtf8`'s default `TextDecoder` is NON-fatal: it substitutes
 * U+FFFD for an ill-formed byte sequence instead of throwing. A cursor whose
 * bytes are not valid UTF-8 but whose REPLACED form is still parseable JSON
 * therefore sailed through every check and resumed the query, where the engine
 * (`String::from_utf8` on the decoded bytes) returns `AppError::Validation`.
 *
 * The fixture puts a lone 0xFF — never valid UTF-8 in any position — inside a
 * JSON string value, so the non-fatal path yields the perfectly well-formed
 * `{"version":1,"values":[{"t":"Text","v":"�"}]}` and nothing downstream
 * has any reason to object.
 */
describe('run_advanced_query — a cursor whose bytes are not valid UTF-8 is rejected (#3914 review note 1)', () => {
  const PAGE = id('L0')
  const ONLY = id('L1')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    const b = makeBlock(ONLY, 'text', null, PAGE, 0)
    b['page_id'] = PAGE
    blocks.set(ONLY, b)
  })

  it('throws a validation rejection instead of decoding the bad byte to U+FFFD', () => {
    const enc = new TextEncoder()
    const bytes = Uint8Array.from([
      ...enc.encode('{"version":1,"values":[{"t":"Text","v":"'),
      0xff,
      ...enc.encode('"}]}'),
    ])
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    const cursor = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

    // Guard against the fixture rotting into a different failure mode: these
    // bytes ARE valid base64url and DO parse as JSON once replaced, so the
    // rejection below can only be coming from the UTF-8 check.
    expect(() => JSON.parse(base64UrlToUtf8(cursor))).not.toThrow()

    expect(() => run({ limit: 10, cursor })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })
})

/**
 * #3914 review note 2 — the round-trip invariant the two handler tests above
 * are only ONE instance of.
 *
 * The keyset resume rests on a single property: the value a row encodes into
 * a cursor must, coming back, compare EQUAL to that same row. Every failure
 * of it is a silent skip or an infinite re-delivery, and it fails per-COLUMN,
 * so a handler test can only ever falsify the columns its fixture happens to
 * exercise. This asserts it directly, for every `CursorKind`, in both
 * directions.
 *
 * `Record<CursorKind, …>` rather than a loose array: adding a seventh kind to
 * the union then fails to COMPILE until it has a case here, which is the only
 * mechanism that keeps "across every kind" true as the set grows.
 *
 * The trip goes through `JSON.parse(JSON.stringify(…))` on purpose — the wire
 * is part of the round trip. An in-memory-only assertion would miss a value
 * that survives the tagging and dies in serialization (`Infinity` has no JSON
 * literal and stringifies to `null`), which is precisely the `Rank` case.
 *
 * Two cases here were RED when this was written, and they are the two the
 * review named: `LastEditedMs`'s never-edited sentinel (`''` → `Int(0)` →
 * decoded back to the NUMBER `0` → compared as `''` vs `'0'`) and `Rank`'s
 * non-finite guard (`Infinity` → `Null` → decoded to `null` → compared as
 * NULLS-LAST against a real number). Both are the same defect: a decode side
 * that was not the inverse of the encode side.
 */
describe('cursorValueFor — every CursorKind round-trips to a value the resume compares EQUAL (#3914 review)', () => {
  type Term = Parameters<typeof cursorValueFor>[0]
  type Entry = Parameters<typeof cursorValueFor>[1]
  type CursorValues = Parameters<typeof compareEntryToCursor>[2]

  /** The getters never read the entry in these cases — the term stands in for one. */
  const ENTRY = {} as Entry

  const CASES: Record<CursorKind, Array<[string, string | number | null]>> = {
    Id: [['a ULID', id('R1')]],
    LastEditedMs: [
      // The `''` sentinel is the case that was broken: it is the one column
      // where the getter's null-ish value is an empty STRING, not `null`.
      ['the never-edited sentinel', ''],
      ['an ISO-8601 op-log stamp', '2024-01-01T00:00:00.000Z'],
    ],
    Position: [
      ['an integral position', 7],
      ['no position (NULL)', null],
    ],
    Priority: [
      ['a user label', 'high'],
      ['no priority (NULL)', null],
    ],
    Rank: [
      ['a fractional bm25 stand-in', 2.5],
      // Integral ranks serialize as `2`, not serde's `2.0` — the documented
      // byte difference, which must still round-trip.
      ['an integral bm25 stand-in', 2],
      ['a non-finite rank', Number.POSITIVE_INFINITY],
    ],
    Title: [
      ['a page title', 'Zulu'],
      ['a non-page row (NULL)', null],
    ],
  }

  for (const [column, cases] of Object.entries(CASES)) {
    for (const [label, raw] of cases) {
      for (const desc of [false, true]) {
        it(`${column}: ${label} (${desc ? 'DESC' : 'ASC'})`, () => {
          const term = { desc, get: () => raw, column } as unknown as Term
          const onWire = JSON.parse(
            JSON.stringify([cursorValueFor(term, ENTRY)]),
          ) as unknown as CursorValues
          expect(compareEntryToCursor([term], ENTRY, onWire)).toBe(0)
        })
      }
    }
  }
})

/**
 * #3914 review round 3 (BLOCKING) — `decodeCursor` validated the ENVELOPE
 * (`version`, `values` is an array) but never the ELEMENTS, so
 * `compareEntryToCursor`'s `ReadonlyArray<CursorValue>` parameter was a
 * type-level claim about runtime input that nothing checked. Two consequences,
 * one of them a crash:
 *
 *  - `{"version":1,"values":[null]}` decoded cleanly, and `isNullCursorValue`
 *    tested `v === undefined` — which does NOT cover `null` — so `null.t`
 *    threw a raw `TypeError`. `dispatch` (`handlers/index.ts`) wraps handlers
 *    in no try/catch, so it escaped the IPC boundary in place of the
 *    `AppError`-shaped rejection the #2463 kind-parity rule requires, from the
 *    very function whose doc promises "never a crash".
 *  - `{"version":1,"values":[{"t":"Int","v":"abc"}]}` decoded cleanly too, and
 *    then `a.v - b.v` is `NaN`: `findIndex` never fires, `startIdx` lands past
 *    the end and the caller gets a silently EMPTY page where the engine's
 *    serde returns `AppError::Validation`. The same mock-is-more-permissive
 *    divergence #3899 exists to close, one level below the four envelope modes
 *    it enumerated.
 *
 * Both are reachable by exactly the route the #3899 tests already use — a
 * hand-built cursor — which is a route any client can take, since the cursor
 * is an opaque string it is free to persist, mangle or replay.
 *
 * The fixture set below is keyed off the engine's `CursorValue`
 * (`#[serde(tag = "t", content = "v")]`, `src-tauri/agaric-store/src/query/engine.rs:143`): serde accepts
 * exactly `Text(String)` / `Int(i64)` / `Real(f64)` / `Null` and rejects every
 * other tag/payload pairing at deserialization.
 */
describe('run_advanced_query — a cursor whose `values` are not CursorValues is rejected (#3914 review)', () => {
  const PAGE = id('M0')
  const ONLY = id('M1')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    const b = makeBlock(ONLY, 'text', null, PAGE, 0)
    b['page_id'] = PAGE
    blocks.set(ONLY, b)
  })

  /** A hand-built cursor carrying arbitrary `values` — what a client can replay. */
  function cursorWith(values: unknown[]): string {
    return utf8ToBase64Url(JSON.stringify({ version: 1, values }))
  }

  it('a JSON `null` element rejects as validation — it does NOT crash with a TypeError', () => {
    const cursor = cursorWith([null])
    // Ordered narrowest-first: a raw TypeError crossing the IPC boundary is a
    // strictly worse failure than a wrong-but-structured rejection, and
    // asserting only `kind: 'validation'` would report the crash as a plain
    // mismatch rather than naming it.
    expect(() => run({ limit: 10, cursor })).not.toThrow(TypeError)
    expect(() => run({ limit: 10, cursor })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })

  it.each([
    ['a wrong-typed payload (Int carrying a string)', [{ t: 'Int', v: 'abc' }]],
    ['a wrong-typed payload (Text carrying a number)', [{ t: 'Text', v: 5 }]],
    ['a fractional Int (serde rejects it for i64)', [{ t: 'Int', v: 1.5 }]],
    ['a tag the engine has no variant for', [{ t: 'Bogus', v: 1 }]],
    ['a missing payload on a value tag', [{ t: 'Text' }]],
    ['a primitive where an object belongs', [42]],
    ['a nested array where an object belongs', [[]]],
    ['a bad element AFTER a good one', [{ t: 'Int', v: 1 }, null]],
  ])('rejects %s', (_label, values) => {
    expect(() => run({ limit: 10, cursor: cursorWith(values) })).toThrow(
      expect.objectContaining({ kind: 'validation' }),
    )
  })

  it('rejects, rather than silently returning an EMPTY page, on a NaN-producing element', () => {
    // The pre-fix symptom, pinned as its own case: `a.v - b.v` is NaN, so no
    // `findIndex` predicate ever holds and the page is empty with `hasMore`
    // false — a resume that looks like "you reached the end".
    let response: QueryResponse | null = null
    expect(() => {
      response = run({ limit: 10, cursor: cursorWith([{ t: 'Int', v: 'abc' }]) })
    }).toThrow(expect.objectContaining({ kind: 'validation' }))
    expect(response).toBeNull()
  })

  it.each([
    ['the Null unit variant', [{ t: 'Null' }]],
    ['the Null unit variant with an explicit null payload', [{ t: 'Null', v: null }]],
    ['an integral Real (serde reads a JSON integer into f64)', [{ t: 'Real', v: 2 }]],
    ['a fractional Real', [{ t: 'Real', v: 2.5 }]],
    ['a negative Int', [{ t: 'Int', v: -7 }]],
    ['an empty Text', [{ t: 'Text', v: '' }]],
  ])('still ACCEPTS %s — the guard rejects malformed input, not valid input', (_label, values) => {
    expect(() => run({ limit: 10, cursor: cursorWith(values) })).not.toThrow()
  })

  it('still accepts the handler’s OWN minted cursor (the guard is not rejecting real traffic)', () => {
    const first = run({ limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    expect(() => run({ limit: 1, cursor: first.nextCursor as string })).not.toThrow()
  })
})

/**
 * #3914 review round 3 note 2 — the rejection MESSAGE is fixed text, not the
 * host runtime's.
 *
 * `describeError` spliced `e.message` from whatever threw, so the bad-base64
 * case read one way under jsdom's `atob` ("The string to be decoded contains
 * invalid characters."), another under Node's, and matched
 * `QueryCursor::decode`'s wording in neither. The PREFIX is what carries the
 * meaning — it names which of the engine's four failure modes fired
 * (`invalid cursor:` / `invalid cursor UTF-8:` / `invalid cursor JSON:` /
 * `cursor: unsupported version`) — so the prefixes are the engine's verbatim
 * and the suffixes are fixed strings of our own rather than a host message
 * masquerading as one.
 *
 * Asserted as EXACT equality, not `stringContaining`: a substring assertion
 * would stay green if the host message came back on the end.
 */
describe('run_advanced_query — cursor rejection messages are fixed, not host-dependent (#3914 review note 2)', () => {
  const PAGE = id('N0')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
  })

  it('bad base64 reports the engine’s first mode', () => {
    expect(() => run({ limit: 10, cursor: '!!!not-base64!!!' })).toThrow(
      expect.objectContaining({ kind: 'validation', message: 'invalid cursor: invalid base64' }),
    )
  })

  it('bad UTF-8 reports the engine’s SECOND mode, distinctly from the first', () => {
    const enc = new TextEncoder()
    const bytes = Uint8Array.from([
      ...enc.encode('{"version":1,"values":[{"t":"Text","v":"'),
      0xff,
      ...enc.encode('"}]}'),
    ])
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    const cursor = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    expect(() => run({ limit: 10, cursor })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message: 'invalid cursor UTF-8: invalid utf-8 sequence',
      }),
    )
  })

  it('non-JSON reports the engine’s third mode', () => {
    expect(() => run({ limit: 10, cursor: utf8ToBase64Url('not json at all') })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message: 'invalid cursor JSON: not valid JSON',
      }),
    )
  })

  it('an unsupported version reports the engine’s fourth mode, verbatim', () => {
    expect(() =>
      run({ limit: 10, cursor: utf8ToBase64Url(JSON.stringify({ version: 99, values: [] })) }),
    ).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message: 'cursor: unsupported version 99 (expected 1)',
      }),
    )
  })
})

/**
 * #3914 review round 3 note 3 — the coupling that keeps the `Rank` non-finite
 * guard UNREACHABLE, asserted rather than assumed.
 *
 * `cursorValueFor` tags a non-finite rank as `Null`, and that tag DISAGREES
 * with how `compareSortValue` orders the raw value under `Relevance DESC`:
 * `Infinity` is a number there, so the `desc` flip sorts it FIRST, while
 * `Null` is NULLS-LAST in both directions and sorts LAST. A row in that state
 * would compare BEFORE the cursor minted from it, `findIndex` would return 0,
 * and every page would re-deliver the whole set — a `while (hasMore)` client
 * that never terminates. It is the one place in the keyset where the two
 * comparison domains do not agree.
 *
 * Nothing makes that state reachable, and the reason is a coupling:
 * `run_advanced_query` narrows with `matchesFtsIndex(strippedFtsOf(m),
 * fulltext)` and ranks with `approximateFtsRank(strippedFtsOf(m),
 * foldForFtsIndex(fulltext))` — the same `stripForFts` haystack (one memo,
 * read by both) through the same `foldForFtsIndex`, against the same folded
 * needle — so `includes` being true guarantees `split` finds ≥ 1 occurrence.
 * That is load-bearing for keyset monotonicity, and it spans two functions
 * either of which could be changed alone. Hence this.
 *
 * #3938 moved BOTH sides off raw content and off `foldForSearch` in one step,
 * which is what kept the coupling intact; this property is the pin that would
 * have caught moving only one. The corpus leans on cases where the strip and
 * the fold are NOT the identity — markup that hides a term from raw content, a
 * `[[ULID]]` that only the stripped text spells out, NFD input that NFC
 * recomposes, and case differences — because a coupling between two
 * transformations can only break where they actually do something.
 */
describe('approximateFtsRank — every row the MATCH narrowing keeps has a FINITE rank (#3914 review note 3)', () => {
  const CONTENTS = [
    'Straße eins',
    'STRASSE zwei',
    'İstanbul',
    'istanbul',
    'naïve',
    'naive',
    'plain ascii text',
    'Ünïcödé — em dash and 🎉 emoji',
    '',
    'ß',
    'aaa',
    // #3938 — content the STRIP changes. Markup hides `gadget` from raw
    // content and the reference tokens carry no plain text at all, so these are
    // rows where the narrowing and the ranking would read different strings if
    // either were still on `blocks.content`.
    'Sprocket **gad**get inventory',
    '`aaa` and ~~aaa~~ and ==aaa==',
    '\\*not emphasis\\* aaa',
    `see [[${'MISSINGPAGE'.padStart(26, '0')}]] and #[${'MISSINGTAG'.padStart(26, '0')}]`,
    // NFD: `e` + combining acute, which NFC recomposes to `é`.
    'cafe\u0301 au lait',
  ]
  const QUERIES = [
    'strasse',
    'Straße',
    'STRASSE',
    'istanbul',
    'İstanbul',
    'naive',
    'naïve',
    'ascii',
    'PLAIN',
    '🎉',
    '—',
    'ß',
    'ss',
    'a',
    'zzz-no-match',
    // A lone combining mark. Under `foldForSearch` this folded AWAY entirely
    // and reached the empty-needle branch through the handler; under
    // `foldForFtsIndex` (NFC + lowercase, neither of which deletes) it is an
    // ordinary needle. Kept because it still exercises a needle that matches
    // only after NFC on one side and not the other.
    '́',
    // The empty needle itself, now reachable only by calling the seam
    // directly: `matchesFtsIndex` admits EVERY row for it, so the rank side
    // must stay finite on rows sharing no character with the query.
    '',
    'gadget',
    'café',
  ]

  it.each(CONTENTS)('content %j: a kept row never ranks non-finite', (content) => {
    for (const query of QUERIES) {
      const stripped = stripForFts(content)
      const kept = matchesFtsIndex(stripped, query)
      const rank = approximateFtsRank(stripped, foldForFtsIndex(query))
      // The implication, not an equivalence: a row the narrowing DROPS is
      // allowed to rank `Infinity` (that is what the guard is for), and one of
      // the fixtures above exercises exactly that.
      if (kept) {
        expect(
          Number.isFinite(rank),
          `kept but non-finite rank: content=${JSON.stringify(content)} query=${JSON.stringify(query)}`,
        ).toBe(true)
      }
    }
  })

  it('the guard IS reachable when the two sides are not coupled — so the check above is not vacuous', () => {
    // A needle the narrowing rejects: this is the only way to reach the
    // `Infinity` branch, and it proves the corpus is capable of producing it.
    expect(matchesFtsIndex('aaa', 'zzz-no-match')).toBe(false)
    expect(approximateFtsRank('aaa', foldForFtsIndex('zzz-no-match'))).toBe(
      Number.POSITIVE_INFINITY,
    )
  })

  // The empty-needle branch, which is now reachable ONLY through this seam
  // (every handler tests blank-ness first, and `foldForFtsIndex` cannot map a
  // non-empty string to `''`). Deleting the branch does not merely change a
  // number: `''.split('')` reports `len - 1` "occurrences", so the guard below
  // would be skipped and the density silently wrong.
  it('an empty needle admits every row and ranks it by length, not by density', () => {
    expect(matchesFtsIndex('abcd', '')).toBe(true)
    expect(approximateFtsRank('abcd', '')).toBe(4)
    // The two halves of the coupling agree on the degenerate input too.
    expect(matchesFtsIndex('', '')).toBe(true)
    expect(approximateFtsRank('', '')).toBe(0)
  })
})

/**
 * The end-to-end half of note 3: a `Relevance DESC` walk terminates.
 *
 * The unit property above pins the coupling; this pins the CONSEQUENCE at the
 * boundary that would actually hurt a client, over a corpus where BOTH
 * transformations do work: the fulltext term matches only after case folding,
 * and one row's term survives only in the STRIPPED text (`**gad**get`), so a
 * narrowing still reading raw `blocks.content` would drop it. If the
 * `Rank` → `Null` narrowing ever became reachable through the handler, this
 * loop would re-deliver the first row forever and abort on the page cap.
 *
 * #3938 replaced the previous corpus, which leaned on `ß` ⇒ `ss`: that fold
 * belongs to `foldForSearch` (the interactive-filter fold) and the FTS index
 * does not perform it, so the old fixture asserted a match the backend never
 * produces.
 */
describe('run_advanced_query — a Relevance DESC keyset walk terminates (#3914 review note 3)', () => {
  const PAGE = id('P0')
  const ONE = id('P1')
  const TWO = id('P2')
  const THREE = id('P3')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Page', null, 0))
    setSpace(PAGE, SPACE_A)
    // Different occurrence counts and lengths ⇒ three distinct ranks. `ONE`
    // hides its term behind bold markup, so it matches only via `stripForFts`.
    for (const [blockId, content] of [
      [ONE, '**Stra**sse'],
      [TWO, 'STRASSE strasse'],
      [THREE, 'strasse and a good deal of additional unrelated content'],
    ] as Array<[string, string]>) {
      const b = makeBlock(blockId, 'text', content, PAGE, 0)
      b['page_id'] = PAGE
      b['content'] = content
      blocks.set(blockId, b)
    }
  })

  it.each([false, true])('desc:%s — every matched row exactly once, one page at a time', (desc) => {
    const request = {
      filter: { type: 'Leaf', primitive: { type: 'BlockType', values: ['text'] } },
      fulltext: 'STRASSE',
      sort: [{ source: { type: 'Relevance' }, desc }],
      limit: 1,
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 12; page++) {
      const response: QueryResponse = run(cursor === null ? request : { ...request, cursor })
      seen.push(...response.rows.map((r) => r['id'] as string))
      if (!response.hasMore) break
      cursor = response.nextCursor
      expect(cursor).not.toBeNull()
    }
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
  })
})
