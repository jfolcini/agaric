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
  blockTags,
  blocks,
  makeBlock,
  opLog,
  pageLastModified,
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
   * #3863 — `pageLastModifiedAt`'s mock-only seeded-stamp fallback (kept for
   * `list_pages_with_metadata`'s dev-preview differentiation) has no engine
   * analogue: `run_advanced_query`'s `LastEdited` sort key is
   * `COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), 0)`
   * (`agaric-store/src/query/engine.rs:229`) with NO other data source, so
   * an op-log-free row on the backend ALWAYS ties with every other
   * op-log-free row at the same sentinel. Before the fix, the sort getter
   * read `pageLastModifiedAt` (which layers the seeded fallback on top), so
   * an op-log-free row with a seeded `pageLastModified` stamp sorted by that
   * stamp instead of tying at the sentinel — ordering by something the
   * engine cannot see.
   */
  it('ignores the mock-only pageLastModified seed fallback the engine has no analogue for — a never-edited row ties at the sentinel, not the seeded stamp', () => {
    const SEEDED = id('B5')
    const seededBlock = makeBlock(SEEDED, 'text', null, PAGE, 0)
    seededBlock['page_id'] = PAGE
    blocks.set(SEEDED, seededBlock)
    // No op-log entry for SEEDED — but a seeded `pageLastModified` stamp
    // between OLD's (Jan 1) and MIDDLE's (Feb 1) edits. If the sort getter
    // used that fallback, SEEDED would slot in between them.
    pageLastModified.set(SEEDED, '2024-01-15T00:00:00.000Z')

    // Engine-faithful ASC order: NEVER and SEEDED both coalesce to the same
    // "no op-log activity" sentinel and TIE, decided only by the id DESC
    // tiebreak (SEEDED's id `…B5` > NEVER's `…B4`, so SEEDED sorts first
    // among the tied pair) — SEEDED must NOT land between OLD and MIDDLE by
    // its seeded stamp.
    expect(
      orderedIds({ filter: TEXT_ONLY, sort: [{ source: { type: 'Column', name: 'lastEdited' } }] }),
    ).toEqual([SEEDED, NEVER, OLD, MIDDLE, NEW])
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
    // TAGGED as an Int (`CursorKind::Position`, `engine.rs:232`), not folded
    // into an untyped `{ id }` object.
    expect(values[0]).toEqual({ t: 'Int', v: 5 })
    // The trailing tiebreak term carries the id, TAGGED as Text
    // (`CursorKind::Id`, `engine.rs:220`).
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
 * #3863 — cursor byte fidelity for values that are not plain ASCII.
 *
 * The cursor payload carries USER TEXT: the `Title` term is the raw page
 * title (`SORT_COLUMN_GETTERS.title` → `row.content`) and `Priority` is a
 * user-configurable label. The engine encodes
 * `URL_SAFE_NO_PAD.encode(json.as_bytes())` (`engine.rs:176`) — i.e. the
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
   * #3863 note 1 — `EngineRow::cursor_value` (`engine.rs:322`) reads the
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
