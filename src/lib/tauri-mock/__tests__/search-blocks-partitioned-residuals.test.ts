/**
 * #4065 — four residuals left behind by the #4030 review of
 * `search_blocks_partitioned`, all pre-existing (none introduced by #4030):
 *
 *  1. the handler ignored `filter` entirely, so a partitioned search was
 *     UNSCOPED where `search_blocks` honours `scope` — the backend threads the
 *     whole `SearchFilter` into both `fts_fetch_rows` calls
 *     (`agaric-store/src/fts/search/partitioned.rs:165-212`): `parent_id`,
 *     `tag_ids`, `space_id`, page-name globs, and the metadata predicates all
 *     reach SQL. `filter.block_type_filter` is the one field that stays
 *     ignored — the partitioning IS the block-type split
 *     (`src-tauri/src/commands/queries.rs:657-663`);
 *  2. `page_limit` / `block_limit` were not bounds-checked at all.
 *     `search_blocks_partitioned_inner` (`queries.rs:735-741`) rejects
 *     anything outside `[0, MAX_SEARCH_RESULTS]` (100) BEFORE dispatch — a
 *     DIFFERENT guard from `search_blocks`'s `[1, 200]` `PageRequest::new`
 *     range, because zero is a legal partitioned ask
 *     (`partitioned.rs:237-238`'s `page_limit_usize > 0 && …`);
 *  3. the blank-query short circuit answered `{ items: [], next_cursor: null,
 *     has_more: false }` — missing `total_count`, which every other path on
 *     this command (and the inner `PageResponse`, `queries.rs:783-796`) sets
 *     to `null`;
 *  4. `stripForFts` ran two or three times per candidate per request (once in
 *     the match-narrowing filter, once per partition it lands in) — a
 *     performance / cleanliness residual, not a behaviour one.
 *
 * Items 1-3 are pinned with a fixture each; item 4 is pinned by counting
 * `content` READS on an instrumented block, since a same-module function
 * (`stripForFts`) cannot be intercepted by `vi.spyOn` from outside the
 * module — that was tried and confirmed not to fire (internal calls in this
 * file bind to the local declaration, not the exported binding object).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { dispatch } from '@/lib/tauri-mock/handlers'
import {
  blockTags,
  blocks,
  makeBlock,
  opLog,
  properties,
  propertyDefs,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

function id(label: string): string {
  return label.padStart(26, '0')
}

const SPACE_A = id('SPACEA')
const SPACE_B = id('SPACEB')

function clearMock(): void {
  seedBlocks()
  blocks.clear()
  blockTags.clear()
  properties.clear()
  propertyDefs.clear()
  opLog.length = 0
}

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

interface SearchResponse {
  items: Array<Record<string, unknown>>
  next_cursor: string | null
  has_more: boolean
  total_count: number | null
}

interface PartitionedResponse {
  pages: SearchResponse
  blocks: SearchResponse
}

function partitioned(args: Record<string, unknown>): PartitionedResponse {
  return dispatch('search_blocks_partitioned', {
    pageLimit: 10,
    blockLimit: 10,
    ...args,
  }) as PartitionedResponse
}

function ids(res: SearchResponse): string[] {
  return res.items.map((b) => b['id'] as string)
}

// ---------------------------------------------------------------------------
// Item 1 — `filter` reaches the scan
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — item 1: honours `filter` (#4065)', () => {
  const PAGE_A = id('QSA1')
  const PAGE_B = id('QSA2')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE_A, makeBlock(PAGE_A, 'page', 'Gizmo Roadmap A', null, 0))
    setSpace(PAGE_A, SPACE_A)
    blocks.set(PAGE_B, makeBlock(PAGE_B, 'page', 'Gizmo Roadmap B', null, 0))
    setSpace(PAGE_B, SPACE_B)
  })

  // The falsifier the issue names: a cross-space fixture.
  it('scopes the scan to the active space, like search_blocks does', () => {
    const res = partitioned({
      query: 'gizmo',
      filter: { scope: { kind: 'active', space_id: SPACE_A } },
    })
    expect(ids(res.pages)).toEqual([PAGE_A])
    expect(ids(res.blocks)).toEqual([PAGE_A])
  })

  it('honours parentId too, the other structural field search_blocks reuses', () => {
    const CHILD = id('QSA3')
    const OTHER = id('QSA4')
    const c = makeBlock(CHILD, 'content', 'gizmo child note', PAGE_A, 1)
    c['page_id'] = PAGE_A
    blocks.set(CHILD, c)
    const o = makeBlock(OTHER, 'content', 'gizmo other note', PAGE_B, 1)
    o['page_id'] = PAGE_B
    blocks.set(OTHER, o)

    const res = partitioned({ query: 'gizmo', filter: { parentId: PAGE_A } })
    expect(ids(res.blocks)).toEqual([CHILD])
  })
})

// ---------------------------------------------------------------------------
// Item 2 — limit validation
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — item 2: validates limits to [0, 100] (#4065)', () => {
  const PAGE = id('QSB1')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'gizmo page', null, 0))
  })

  it('rejects an over-cap blockLimit instead of silently serving it', () => {
    expect(() => partitioned({ query: 'gizmo', pageLimit: 10, blockLimit: 101 })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message:
          'partitioned search limits must each be in [0, 100]; got page_limit=10, block_limit=101',
      }),
    )
  })

  it('rejects an over-cap pageLimit too', () => {
    expect(() => partitioned({ query: 'gizmo', pageLimit: 150, blockLimit: 10 })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message:
          'partitioned search limits must each be in [0, 100]; got page_limit=150, block_limit=10',
      }),
    )
  })

  // The other half of the pair: zero is legal HERE (unlike `search_blocks`),
  // so the guard must not reject it. Already covered for empty-answer shape in
  // `search-fts-strip.test.ts`; asserted here too so this file's guard change
  // is shown not to have widened the rejected range.
  it('still accepts a zero limit', () => {
    expect(() => partitioned({ query: 'gizmo', pageLimit: 0, blockLimit: 0 })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Item 3 — total_count on the blank-query short circuit
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — item 3: total_count on the blank-query answer (#4065)', () => {
  it('answers a blank query with total_count: null on both partitions, like every other path', () => {
    const res = partitioned({ query: '' })
    expect(res.pages).toHaveProperty('total_count', null)
    expect(res.blocks).toHaveProperty('total_count', null)
  })
})

// ---------------------------------------------------------------------------
// Item 4 — `stripForFts` runs at most once per candidate per request
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — item 4: content is stripped once per candidate (#4065)', () => {
  const PAGE = id('QSD1')

  /** Replaces `block.content` with a counting accessor. Reading `content` is
   *  1:1 with a `stripForFts` call on this handler's every path: nothing else
   *  in `search_blocks_partitioned` reads a candidate's `content`, and
   *  `stripForFts` never re-reads its own argument. */
  function instrumentContent(
    block: Record<string, unknown>,
    value: string,
  ): { count: () => number } {
    let n = 0
    Object.defineProperty(block, 'content', {
      get() {
        n++
        return value
      },
      enumerable: true,
      configurable: true,
    })
    return { count: () => n }
  }

  beforeEach(clearMock)

  it("reads a page-typed match's content once, not up to three times", () => {
    const b = makeBlock(PAGE, 'page', '', null, 0)
    blocks.set(PAGE, b)
    const reads = instrumentContent(b, 'gizmo widget')

    partitioned({ query: 'gizmo' })

    expect(reads.count()).toBe(1)
  })
})
