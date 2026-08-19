/**
 * #4159 — the three residuals #4158 left behind in the tauri-mock of the Rust
 * search / unlinked-references commands. All three are pre-existing; none was
 * introduced there.
 *
 *  1. `searchHasStructuralFilter` counted the page-name globs and the eight
 *     `SearchFilter` fields `prepare_metadata` folds into
 *     `MetadataPredicates`, while `searchStructuralCandidates` applied only
 *     `parentId` / `tagIds` / `scope` / `blockTypeFilter`. The two halves
 *     disagreeing means a blank query whose only filter is a metadata one (or
 *     a glob) takes the FILTERED arm and then returns EVERY live in-scope
 *     block, where the backend returns only the matching ones
 *     (`agaric-store/src/fts/toggle_filter.rs:155-181` and `:331-360`, whose
 *     `fts_fetch_filter_only_page` / `fts_fetch_filter_only_partitioned` both
 *     run the full `apply_structural_filters` clause set, `:1021-1049`);
 *  2. `PALETTE_CONTENT_PREVIEW_CAP` (512 codepoints,
 *     `fts/search/partitioned.rs:53`) was unmodelled. It is a per-CALLER
 *     argument: the all-toggles-off partitioned arm passes it
 *     (`toggle_filter.rs:466-473`) and the `case_sensitive` / `whole_word` arm
 *     passes `None` so its post-filter regex can still match past the cut
 *     (`:499-521`). The asymmetry is the behaviour, not the cap alone;
 *  3. `list_unlinked_references` resolved the search title from ANY block.
 *     `eval_unlinked_references` guards the lookup with `block_type = 'page'
 *     AND deleted_at IS NULL` (`agaric-store/src/backlink/grouped.rs:588-591`)
 *     so a conflict-copy page id never drives the search — while leaving the
 *     ALIAS half unguarded (`:601-605`), which the mock's `blocks.get(pageId)`
 *     early-return also got wrong, in the other direction.
 *
 * Every `it` below was RED against the pre-fix handlers.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { clearMock, id } from '@/lib/tauri-mock/__tests__/mock-store-helpers'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, pageAliases } from '@/lib/tauri-mock/seed'

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

interface GroupedResponse {
  groups: Array<{ page_id: string; page_title: string | null; blocks: Array<{ id: string }> }>
}

function search(args: Record<string, unknown>): SearchResponse {
  return dispatch('search_blocks', { cursor: null, limit: null, ...args }) as SearchResponse
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
// Item 1 — the fields `searchHasStructuralFilter` counts are the fields
// `searchStructuralCandidates` applies
// ---------------------------------------------------------------------------

describe('search structural scan — item 1: metadata predicates (#4159)', () => {
  const PAGE = id('MDP1')
  const TODO = id('MDB1')
  const DONE = id('MDB2')

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Metadata Page', null, 0))
    const todo = makeBlock(TODO, 'content', 'first task', PAGE, 1)
    todo['todo_state'] = 'TODO'
    todo['priority'] = 'A'
    todo['due_date'] = '2026-03-04'
    blocks.set(TODO, todo)
    const done = makeBlock(DONE, 'content', 'second task', PAGE, 2)
    done['todo_state'] = 'DONE'
    blocks.set(DONE, done)
  })

  // The falsifier the issue names: a blank query whose ONLY filter is a
  // metadata one returns fewer rows than the unfiltered live set.
  it('narrows the blank-query filtered arm by `stateFilter`', () => {
    // Baseline — the arm itself is reached, and unfiltered it is the whole
    // live set in `id DESC`.
    expect(ids(search({ query: '', filter: { parentId: PAGE } }))).toEqual([DONE, TODO])
    expect(ids(search({ query: '', filter: { stateFilter: ['TODO'] } }))).toEqual([TODO])
  })

  it('splits the `none` sentinel out of `stateFilter` into an IS NULL branch', () => {
    // `state:none` selects `todo_state IS NULL` — the PAGE row, and only it
    // (`metadata_filter.rs:163-169`).
    expect(ids(search({ query: '', filter: { stateFilter: ['none'] } }))).toEqual([PAGE])
    // With a value alongside, the two are OR-joined.
    expect(ids(search({ query: '', filter: { stateFilter: ['none', 'DONE'] } }))).toEqual([
      PAGE,
      DONE,
    ])
  })

  it('keeps NULL-state rows on an `excludedStateFilter` without the sentinel', () => {
    // `b.todo_state IS NULL OR todo_state NOT IN (...)` — the inversion
    // deliberately includes the NULL bucket (`SearchFilter::excluded_state_filter`).
    expect(ids(search({ query: '', filter: { excludedStateFilter: ['DONE'] } }))).toEqual([
      PAGE,
      TODO,
    ])
    // ...and drops it when the sentinel is present too (#2019's AND-join).
    expect(ids(search({ query: '', filter: { excludedStateFilter: ['DONE', 'none'] } }))).toEqual([
      TODO,
    ])
  })

  it('narrows by `priorityFilter` and by an explicit `dueFilter` comparison', () => {
    expect(ids(search({ query: '', filter: { priorityFilter: ['A'] } }))).toEqual([TODO])
    expect(
      ids(search({ query: '', filter: { dueFilter: { op: { op: 'gte', date: '2026-03-04' } } } })),
    ).toEqual([TODO])
    expect(
      ids(search({ query: '', filter: { dueFilter: { op: { op: 'lt', date: '2026-03-04' } } } })),
    ).toEqual([])
  })

  it('applies the same narrowing on `search_blocks_partitioned`', () => {
    // #4158 put this arm on the partitioned command too, which is what made
    // the disagreement reachable twice.
    const res = partitioned({ query: '', filter: { stateFilter: ['TODO'] } })
    expect(ids(res.pages)).toEqual([])
    expect(ids(res.blocks)).toEqual([TODO])
  })

  it('narrows a non-blank FTS query by the same predicates', () => {
    // Not a blank-arm-only fix: `apply_structural_filters` is shared by every
    // arm, so the FTS arm carries the metadata clauses as well.
    expect(ids(search({ query: 'task' }))).toEqual([TODO, DONE])
    expect(ids(search({ query: 'task', filter: { stateFilter: ['DONE'] } }))).toEqual([DONE])
  })
})

describe('search structural scan — item 1: page-name globs (#4159)', () => {
  const ALPHA = id('GLPA')
  const ALPHA_CHILD = id('GLBA')
  const BETA = id('GLPB')
  const BETA_CHILD = id('GLBB')

  beforeEach(() => {
    clearMock()
    blocks.set(ALPHA, makeBlock(ALPHA, 'page', 'Alpha Notes', null, 0))
    blocks.set(ALPHA_CHILD, makeBlock(ALPHA_CHILD, 'content', 'alpha body', ALPHA, 1))
    blocks.set(BETA, makeBlock(BETA, 'page', 'Beta Notes', null, 0))
    blocks.set(BETA_CHILD, makeBlock(BETA_CHILD, 'content', 'beta body', BETA, 1))
  })

  it('restricts the scan to blocks whose owning page title matches an include glob', () => {
    // `b.page_id IN (SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?)`
    // — a page carries `page_id = id`, so it is matched by its OWN title.
    expect(ids(search({ query: '', filter: { includePageGlobs: ['alpha*'] } }))).toEqual([
      ALPHA,
      ALPHA_CHILD,
    ])
  })

  it('AND-joins the exclude globs as a NOT IN', () => {
    expect(ids(search({ query: '', filter: { excludePageGlobs: ['beta*'] } }))).toEqual([
      ALPHA,
      ALPHA_CHILD,
    ])
  })

  it('drops blocks whose owning page is absent from pages_cache on an include glob', () => {
    // `rebuild_pages_cache` selects `deleted_at IS NULL`
    // (`agaric-store/src/cache/pages.rs:34-41`), so soft-deleting the page
    // removes its cache row — and with it every `IN` membership its live
    // blocks had.
    const alpha = blocks.get(ALPHA)
    if (alpha) alpha['deleted_at'] = '2026-01-01T00:00:00Z'
    expect(ids(search({ query: '', filter: { includePageGlobs: ['alpha*'] } }))).toEqual([])
    // The exclude half is the other way round: not a member of the excluded
    // set, so `NOT IN` holds and the orphaned child survives.
    expect(ids(search({ query: '', filter: { excludePageGlobs: ['beta*'] } }))).toEqual([
      ALPHA_CHILD,
    ])
  })
})

// ---------------------------------------------------------------------------
// Item 2 — `PALETTE_CONTENT_PREVIEW_CAP`, on arm 4 and NOT on arm 5
// ---------------------------------------------------------------------------

describe('search_blocks_partitioned — item 2: content preview cap (#4159)', () => {
  const PAGE = id('CAPP')
  const LONG = id('CAPB')
  // 600 astral codepoints (1200 UTF-16 units) ahead of the term, so a
  // `slice(0, 512)` would cut 256 emoji and a `substr`-faithful cut takes 512.
  const CONTENT = `${'\u{1F600}'.repeat(600)} zebrafish`

  beforeEach(() => {
    clearMock()
    blocks.set(PAGE, makeBlock(PAGE, 'page', 'Cap Page', null, 0))
    blocks.set(LONG, makeBlock(LONG, 'content', CONTENT, PAGE, 1))
  })

  it('truncates content to 512 CODEPOINTS on the all-toggles-off arm', () => {
    const res = partitioned({ query: 'zebrafish', filter: {} })
    expect(ids(res.blocks)).toEqual([LONG])
    const shipped = res.blocks.items[0]?.['content'] as string
    expect([...shipped]).toHaveLength(512)
    // Not 512 UTF-16 units: the cut counts codepoints, so 512 astral chars
    // occupy 1024 units and no surrogate pair is split.
    expect(shipped).toHaveLength(1024)
    expect(shipped).toBe('\u{1F600}'.repeat(512))
  })

  it('ships FULL content on the case-sensitive / whole-word arm', () => {
    // `snippet_len: None` there, so the post-filter regex can match past the
    // cut instead of silently dropping the row.
    const res = partitioned({ query: 'zebrafish', filter: { caseSensitive: true } })
    expect(ids(res.blocks)).toEqual([LONG])
    expect(res.blocks.items[0]?.['content']).toBe(CONTENT)
  })

  it('leaves the stored block untouched', () => {
    partitioned({ query: 'zebrafish', filter: {} })
    expect(blocks.get(LONG)?.['content']).toBe(CONTENT)
  })

  it('does not truncate on `search_blocks`, which passes no cap at all', () => {
    // The FE/IPC path passes `snippet_len: None` on every arm; only the MCP
    // `search` tool caps there (`toggle_filter.rs:140-145`).
    const res = search({ query: 'zebrafish' })
    expect(res.items[0]?.['content']).toBe(CONTENT)
  })
})

// ---------------------------------------------------------------------------
// Item 3 — the guarded title lookup, and the unguarded alias lookup
// ---------------------------------------------------------------------------

describe('list_unlinked_references — item 3: title lookup guard (#4159)', () => {
  const TARGET = id('ULRP')
  const OTHER = id('ULRQ')
  const MENTION = id('ULRM')
  const PLAIN = id('ULRN')
  const IMPOSTOR = id('ULRC')
  const DELETED = id('ULRD')

  function unlinked(pageId: string): GroupedResponse {
    return dispatch('list_unlinked_references', {
      pageId,
      scope: { kind: 'global' },
    }) as GroupedResponse
  }

  function mentionIds(res: GroupedResponse): string[] {
    return res.groups.flatMap((g) => g.blocks.map((b) => b.id))
  }

  beforeEach(() => {
    clearMock()
    blocks.set(TARGET, makeBlock(TARGET, 'page', 'Zebrafish', null, 0))
    blocks.set(OTHER, makeBlock(OTHER, 'page', 'Lab Notes', null, 0))
    blocks.set(MENTION, makeBlock(MENTION, 'content', 'notes on zebrafish habitat', OTHER, 1))
    blocks.set(PLAIN, makeBlock(PLAIN, 'content', 'a second zebrafish sighting', OTHER, 2))
    // A CONTENT block whose text happens to read like the page title — the
    // shape the backend's `block_type = 'page'` predicate exists to reject.
    blocks.set(IMPOSTOR, makeBlock(IMPOSTOR, 'content', 'Zebrafish', OTHER, 3))
    const deleted = makeBlock(DELETED, 'page', 'Zebrafish', null, 0)
    deleted['deleted_at'] = '2026-01-01T00:00:00Z'
    blocks.set(DELETED, deleted)
  })

  it('still searches on a live page title', () => {
    expect(mentionIds(unlinked(TARGET)).toSorted()).toEqual([IMPOSTOR, MENTION, PLAIN].toSorted())
  })

  it('answers empty for a pageId naming a content block', () => {
    expect(unlinked(IMPOSTOR).groups).toEqual([])
  })

  it('answers empty for a soft-deleted page', () => {
    expect(unlinked(DELETED).groups).toEqual([])
  })

  it('still searches a soft-deleted page on its ALIAS, which carries no guard', () => {
    // `SELECT alias FROM page_aliases WHERE page_id = ?1` is unconditional
    // (`grouped.rs:601-605`), and `title = None` is not an early return on the
    // backend — so the alias term alone drives the search.
    pageAliases.set(DELETED, ['habitat'])
    expect(mentionIds(unlinked(DELETED))).toEqual([MENTION])
  })
})
