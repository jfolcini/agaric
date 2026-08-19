/**
 * `search_blocks_partitioned` — the arms the mock did not have, and the
 * boundaries #4151 claimed but did not pin.
 *
 * Every fixture here reddens against `848e98679` (the #4151 merge). The Rust
 * they are checked against is `search_with_toggles_partitioned`
 * (`src-tauri/agaric-store/src/fts/toggle_filter.rs:309-543`) and the command
 * wrapper above it (`src-tauri/src/commands/queries.rs:713-790`).
 *
 *  1. **Blank query + a structural filter.** `toggle_filter.rs:330-360`
 *     returns the structurally-filtered partitions RECENCY-ordered via
 *     `fts_fetch_filter_only_partitioned` (`:1233-1288`), and two EMPTY
 *     partitions only when `has_filters` is false. The mock returned empty
 *     unconditionally. `block_type_filter` is not a parameter of the
 *     partitioned function, so — unlike `search_with_toggles`' disjunction at
 *     `:154-161` — it is not one of its `has_filters` disjuncts.
 *  2. **`'   '` is blank.** Both `toggle_filter.rs:330` and
 *     `partitioned.rs:127` test `query.trim().is_empty()`; the mock tested
 *     `!query`, so a whitespace query reached the FTS path and matched on a
 *     space substring.
 *  3. **The limit guard's boundaries.** `queries.rs:735-741` rejects outside
 *     `[0, MAX_SEARCH_RESULTS]` inclusive; only `101`, `150` and `0` were
 *     exercised, so nothing failed if `<=` became `<`.
 *  4. **Kind, for the two values the backend never turns into an `AppError`.**
 *     `page_limit` / `block_limit` are `u32` (`queries.rs:715-716`), so `-1`
 *     and `50.5` die in serde at the IPC boundary. The assertions below pin
 *     only THAT the mock refuses, never a kind — the documented exception
 *     `search_blocks` already carries.
 *  5. **Two partitions, two objects.** One shared literal handed both
 *     partitions the same `items` array.
 *  6. **The three toggles.** `is_regex` (`:363-453`), and
 *     `case_sensitive` / `whole_word` (`:479-543`) were unmodelled here while
 *     the backend honours all three — the largest divergence left on this
 *     command.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearMock, id, setSpace } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock } from '@/lib/tauri-mock/seed'

const SPACE = id('SPACEP')

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

/** Insert a block, put it in {@link SPACE}, and return its id. */
function put(blockId: string, type: string, content: string | null, parent: string | null): string {
  const b = makeBlock(blockId, type, content, parent, 1)
  blocks.set(blockId, b)
  setSpace(blockId, SPACE)
  return blockId
}

// ---------------------------------------------------------------------------
// 1 — blank query + a structural filter
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — blank query with a structural filter (#4036)', () => {
  const PARENT = id('BQP1')
  const OTHER = id('BQP2')
  const KID_A = id('BQP3')
  const KID_B = id('BQP4')
  const KID_OTHER = id('BQP5')

  beforeEach(() => {
    clearMock()
    put(PARENT, 'page', 'Parent Page', null)
    put(OTHER, 'page', 'Other Page', null)
    put(KID_A, 'content', 'first note', PARENT)
    put(KID_B, 'content', 'second note', PARENT)
    put(KID_OTHER, 'content', 'foreign note', OTHER)
  })

  // The falsifier: this used to be two empty partitions.
  it('returns the filtered partitions recency-ordered, not two empty ones', () => {
    const res = partitioned({ query: '', filter: { parentId: PARENT } })
    // `filter_only_scan` is `ORDER BY b.id DESC` (toggle_filter.rs:1141-1145).
    expect(ids(res.blocks)).toEqual([KID_B, KID_A])
    // No page-typed row is a child of PARENT, so the pages partition is empty
    // — the partition split is `block_type = 'page'`, applied per scan.
    expect(ids(res.pages)).toEqual([])
  })

  it('splits page-typed rows into the pages partition on this arm too', () => {
    const CHILD_PAGE = id('BQP6')
    put(CHILD_PAGE, 'page', 'Child Page', PARENT)
    const res = partitioned({ query: '', filter: { parentId: PARENT } })
    expect(ids(res.pages)).toEqual([CHILD_PAGE])
    expect(ids(res.blocks)).toEqual([CHILD_PAGE, KID_B, KID_A])
  })

  it('still answers two empty partitions when no user filter is present', () => {
    const res = partitioned({ query: '', filter: { scope: { kind: 'active', space_id: SPACE } } })
    expect(ids(res.pages)).toEqual([])
    expect(ids(res.blocks)).toEqual([])
    // `space_id` is always supplied by the backend, so it is not a USER filter
    // and `has_filters` excludes it (toggle_filter.rs:326-329).
  })

  it('does NOT count blockTypeFilter as a filter, where search_blocks does', () => {
    // `search_with_toggles_partitioned` has no `block_type_filter` parameter,
    // so its `has_filters` (toggle_filter.rs:331-335) omits the disjunct
    // `search_with_toggles`' (`:155-160`) carries. The two commands therefore
    // answer the same blank request differently, on purpose.
    const part = partitioned({ query: '', filter: { blockTypeFilter: 'page' } })
    expect(ids(part.blocks)).toEqual([])

    const flat = dispatch('search_blocks', {
      query: '',
      filter: { blockTypeFilter: 'page' },
      limit: 50,
    }) as SearchResponse
    expect(flat.items.map((b) => b['id'])).toEqual([OTHER, PARENT])
  })

  it('derives has_more from the limit + 1 probe, and answers false at limit 0', () => {
    const one = partitioned({ query: '', filter: { parentId: PARENT }, blockLimit: 1 })
    expect(ids(one.blocks)).toEqual([KID_B])
    expect(one.blocks.has_more).toBe(true)

    // `page_limit_usize > 0 && …` (toggle_filter.rs:1277-1281) — a caller that
    // asked for nothing is not told there is more.
    const none = partitioned({ query: '', filter: { parentId: PARENT }, blockLimit: 0 })
    expect(ids(none.blocks)).toEqual([])
    expect(none.blocks.has_more).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2 — a whitespace-only query is blank
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — a whitespace query is blank (#4036)', () => {
  const PAGE = id('WSQ1')
  const NOTE = id('WSQ2')

  beforeEach(() => {
    clearMock()
    put(PAGE, 'page', 'Whitespace   Page', null)
    // THREE consecutive spaces, so `'   '` run as a literal substring needle
    // is a hit on both rows — the assertion below is only non-vacuous because
    // of them.
    put(NOTE, 'content', 'a note   with spaces', PAGE)
  })

  it('does not match every block containing a run of spaces', () => {
    const res = partitioned({ query: '   ' })
    expect(ids(res.blocks)).toEqual([])
    expect(ids(res.pages)).toEqual([])
  })

  it('takes the FILTERED blank arm when a filter is present, not the FTS one', () => {
    const res = partitioned({ query: '   ', filter: { parentId: PAGE } })
    // FTS on `'   '` would rank; the blank arm orders `b.id DESC`. Both return
    // NOTE here — what distinguishes them is the pages partition, which the
    // FTS path would also fill from a space substring hit on the page title.
    expect(ids(res.blocks)).toEqual([NOTE])
    expect(ids(res.pages)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3 + 4 — the limit guard's boundaries and kinds
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — limit guard boundaries (#4036)', () => {
  beforeEach(() => {
    clearMock()
    put(id('LGB1'), 'page', 'gizmo page', null)
  })

  // The inclusive cap, pinned from both sides: nothing here fails if `<=`
  // silently becomes `<` unless 100 is asserted to be ACCEPTED.
  it.each([0, 1, 100])('accepts %i, inside [0, 100]', (limit) => {
    expect(() => partitioned({ query: 'gizmo', pageLimit: limit, blockLimit: limit })).not.toThrow()
  })

  it('rejects 101, one past the inclusive cap, with the backend message', () => {
    expect(() => partitioned({ query: 'gizmo', pageLimit: 101, blockLimit: 10 })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        message:
          'partitioned search limits must each be in [0, 100]; got page_limit=101, block_limit=10',
      }),
    )
  })

  // The two values the backend never turns into an `AppError` — `u32` serde
  // refuses them at the IPC boundary. So THAT it refuses is the contract; the
  // kind is the mock's own and is deliberately not asserted.
  it.each([-1, 50.5])('refuses %s, which serde refuses on the other side', (limit) => {
    expect(() => partitioned({ query: 'gizmo', pageLimit: limit, blockLimit: 10 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 5 — two partitions, two objects
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — the partitions are distinct objects (#4036)', () => {
  it('does not hand both partitions one shared items array on the empty answer', () => {
    clearMock()
    const res = partitioned({ query: '' })
    expect(res.pages).not.toBe(res.blocks)
    expect(res.pages.items).not.toBe(res.blocks.items)
    res.pages.items.push({ id: 'X' })
    expect(res.blocks.items).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 6 — the three toggles
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — honours the search toggles (#4036)', () => {
  const PAGE = id('TGL1')
  const UPPER = id('TGL2')
  const LOWER = id('TGL3')
  const SUBSTR = id('TGL4')

  beforeEach(() => {
    clearMock()
    put(PAGE, 'page', 'Gizmo index', null)
    put(UPPER, 'content', 'Gizmo shipped', PAGE)
    put(LOWER, 'content', 'gizmo shipped', PAGE)
    put(SUBSTR, 'content', 'gizmos everywhere', PAGE)
  })

  it('narrows both partitions by caseSensitive', () => {
    // FTS5 trigram folds case, so all four rows are candidates; the post-filter
    // regex `(?-i)Gizmo` (compose_literal_pattern, toggle_filter.rs:556-600)
    // is what drops the lowercase ones.
    const res = partitioned({ query: 'Gizmo', filter: { caseSensitive: true } })
    expect(ids(res.blocks).toSorted()).toEqual([PAGE, UPPER].toSorted())
    expect(ids(res.pages)).toEqual([PAGE])
  })

  it('narrows both partitions by wholeWord', () => {
    const res = partitioned({ query: 'gizmo', filter: { wholeWord: true } })
    expect(ids(res.blocks)).not.toContain(SUBSTR)
    expect(ids(res.blocks).toSorted()).toEqual([PAGE, UPPER, LOWER].toSorted())
  })

  it('runs isRegex against raw content, recency-ordered, FTS bypassed', () => {
    // A character class is not a trigram query — the regex arm bypasses FTS
    // entirely (toggle_filter.rs:363-453), so this matches where arm 4 could
    // not express the ask at all. Case-insensitive because `is_regex` without
    // `case_sensitive` still gets the `(?i)` prefix (`:363-372` → the shared
    // wrappers), so both cased rows survive.
    const res = partitioned({ query: 'G[a-z]+o ship', filter: { isRegex: true } })
    // `ORDER BY b.id DESC` from `regex_mode_query` (toggle_filter.rs:866-869),
    // NOT rank order — LOWER's id sorts above UPPER's.
    expect(ids(res.blocks)).toEqual([LOWER, UPPER])
    expect(ids(res.pages)).toEqual([])
  })

  it('gives the regex pages partition its own SQL-pushed block_type window', () => {
    // `i.dex` is a pattern, not a trigram query: the FTS arm cannot express it
    // at all, so a mock that still routed this to arm 4 answers empty.
    const res = partitioned({ query: 'i.dex', filter: { isRegex: true } })
    expect(ids(res.pages)).toEqual([PAGE])
    expect(ids(res.blocks)).toEqual([PAGE])
  })

  it('probes has_more on the toggle arms too', () => {
    const res = partitioned({ query: 'gizmo', filter: { wholeWord: true }, blockLimit: 1 })
    expect(res.blocks.items).toHaveLength(1)
    expect(res.blocks.has_more).toBe(true)
  })
})
