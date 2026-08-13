/**
 * Tauri mock handlers -- Full-text and filtered block search.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import { foldForSearch, matchesSearchFolded } from '@/lib/fold-for-search'
import {
  type PageMetaRow,
  type TypedHandlers,
  buildPageMetaRow,
  deriveLinkEdges,
  fbqInSpace,
  fbqPropertyFilterMatches,
  fbqTagFilterMatches,
  metaRowMatchesExpr,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blocks, properties } from '@/lib/tauri-mock/seed'

// ---------------------------------------------------------------------------
// #3837 — `run_advanced_query` sort + full-text narrowing.
//
// Mirrors `resolve_sort` in `agaric-store/src/query/engine.rs`: each
// requested `SortKey` maps to a getter over the matched row, applied
// left-to-right in request order, ALWAYS terminating in an `id` tiebreak so
// the order is total. `NULLS LAST` applies uniformly to every term — exactly
// like the engine's `"{expr} {dir} NULLS LAST"` ORDER BY term — which is a
// no-op on the columns that are never actually null (`id`, the coalesced
// `lastEdited`) and only bites on `position` / `priority` / `title`.
// ---------------------------------------------------------------------------

interface MatchedEntry {
  b: Record<string, unknown>
  row: PageMetaRow
}

type SortValue = string | number | null

interface ResolvedSortTerm {
  desc: boolean
  get: (m: MatchedEntry) => SortValue
}

/**
 * Approximates `fts.rank` (a `bm25` score; lower = better match). The mock
 * has no FTS5 index to query, so this is a DELIBERATE, DOCUMENTED
 * approximation rather than real bm25 — two divergences worth knowing about:
 *
 *  - Real bm25 folds in corpus-wide inverse document frequency and a
 *    term-frequency saturation curve. This uses a plain
 *    content-length-over-occurrence-count density ratio (more hits and
 *    shorter surrounding content both score lower/better). It produces a
 *    STABLE, non-arbitrary relative order for the mock's relevance sort —
 *    it is not a bm25 stand-in for anything ranking-accuracy sensitive.
 *  - Real ranking runs over `strip_for_fts_with_maps`'s stripped text, which
 *    also embeds referenced tag/page NAMES, so a block linking `[[Foo]]`
 *    ranks for a `Foo` query even without the literal substring. This scores
 *    the block's raw `content` only — the same simplification this file's
 *    `search_blocks` / `search_blocks_partitioned` handlers already make.
 *    Same for the MATCH narrowing itself (below): it is a folded substring
 *    test, not an FTS5 trigram/`sanitize_fts_query` query.
 *
 * That second divergence runs in BOTH directions, which is easy to miss
 * because only the false-negative half is obvious:
 *
 *  - FALSE NEGATIVE (the `[[Foo]]` case above): real FTS matches text this
 *    scan cannot see, so the mock under-matches.
 *  - FALSE POSITIVE: real FTS indexes the STRIPPED text, so the markdown
 *    delimiters themselves are gone from it. This scans raw `content`, where
 *    they are still present — a query containing `**`, `[[` or `#` can match
 *    here and match nothing in the real index. The same asymmetry skews the
 *    score even when both agree on matching, since `foldedText.length` counts
 *    delimiter characters that real bm25's document length never saw, so a
 *    heavily-formatted block ranks worse here than it does in the backend.
 *
 * Neither direction is a defect to fix in the mock — reproducing them needs
 * the real stripper and an FTS5 index. They are the boundary of what a mock
 * relevance assertion can be trusted to prove, and a test that depends on
 * either direction is testing this approximation, not the backend.
 */
function approximateFtsRank(content: string | null, foldedQuery: string): number {
  const foldedText = foldForSearch(content ?? '')
  if (foldedQuery === '') return foldedText.length
  const occurrences = foldedText.split(foldedQuery).length - 1
  // No match: unreachable via the MATCH narrowing below (which already
  // excludes non-matching rows), but total for defensive callers.
  if (occurrences === 0) return Number.POSITIVE_INFINITY
  return foldedText.length / occurrences
}

/** Value getters for the closed `SortColumn` set, over a matched `{ b, row }` pair. */
const SORT_COLUMN_GETTERS: Record<string, (m: MatchedEntry) => SortValue> = {
  // ULID id == creation order (`resolve_sort`'s `SortColumn::Created`).
  created: (m) => m.row.id,
  // The engine applies COALESCE to the op_log MAX to epoch-ms `0` (never actually
  // NULL); `lastModifiedAt` is this mock's pre-existing ISO-8601 string
  // representation of the same value (`pageLastModifiedAt`), so `''` is the
  // matching "no op-log activity" sentinel — it sorts before every real
  // ISO-8601 timestamp string, preserving relative order.
  lastEdited: (m) => m.row.lastModifiedAt ?? '',
  position: (m) => m.row.position,
  priority: (m) => m.row.priority,
  // `pc.title` comes from the `pages_cache` row whose `page_id = b.id` — the
  // matched row's OWN page-cache entry, which only exists when the row IS a
  // page. Non-page rows get `null` (NULLS LAST), mirroring the LEFT JOIN.
  title: (m) => (m.row.blockType === 'page' ? m.row.content : null),
}

/**
 * Resolve a request's wire `sort: SortKey[]` into ordered comparator terms,
 * mirroring `resolve_sort`: explicit keys first (request order), then the
 * engine's own default (`Relevance` when `fulltext` is present, `id DESC`
 * otherwise) when the request supplied no keys, then an `id DESC` tiebreak
 * appended unless a `Created` key already supplies one. Rejects `Relevance`
 * when there is no `fulltext` term, exactly like the engine.
 */
function resolveSortTerms(
  sort: ReadonlyArray<Record<string, unknown>>,
  hasFulltext: boolean,
  foldedQuery: string,
): ResolvedSortTerm[] {
  const terms: ResolvedSortTerm[] = []
  let hasCreated = false
  for (const key of sort) {
    const desc = (key['desc'] as boolean | undefined) ?? false
    const source = (key['source'] as Record<string, unknown> | undefined) ?? {}
    if (source['type'] === 'Relevance') {
      if (!hasFulltext) {
        throw validationRejection('InvalidSort: `Relevance` requires a `fulltext` term to rank on')
      }
      terms.push({ desc, get: (m) => approximateFtsRank(m.row.content, foldedQuery) })
      continue
    }
    const name = source['name'] as string | undefined
    const getter = name ? SORT_COLUMN_GETTERS[name] : undefined
    if (!getter) continue
    if (name === 'created') hasCreated = true
    terms.push({ desc, get: getter })
  }
  // Default sort when the request gave none.
  if (terms.length === 0 && hasFulltext) {
    terms.push({ desc: false, get: (m) => approximateFtsRank(m.row.content, foldedQuery) })
  }
  if (!hasCreated) {
    terms.push({ desc: true, get: (m) => m.row.id })
  }
  return terms
}

/**
 * One term's comparison, honouring `NULLS LAST` in BOTH directions — matches
 * the engine's `"{expr} {dir} NULLS LAST"` ORDER BY term, where a NULL value
 * sorts last regardless of ASC/DESC.
 */
function compareSortValue(a: SortValue, b: SortValue, desc: boolean): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  let cmp: number
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b
  } else {
    const as = String(a)
    const bs = String(b)
    cmp = as < bs ? -1 : as > bs ? 1 : 0
  }
  return desc ? -cmp : cmp
}

function compareByTerms(terms: ReadonlyArray<ResolvedSortTerm>) {
  return (x: MatchedEntry, y: MatchedEntry): number => {
    for (const term of terms) {
      const cmp = compareSortValue(term.get(x), term.get(y), term.desc)
      if (cmp !== 0) return cmp
    }
    return 0
  }
}

export const searchHandlers = {
  // #1280 — advanced-query engine. The mock cannot compile a `FilterExpr` tree
  // to SQL, so it INTERPRETS it in TypeScript instead. The GROUPED + AGGREGATE
  // response paths are still SYNTHESISED from the request shape (the mock does
  // not compute real buckets/folds yet):
  //   - `aggregates` requested → echo one `AggregateResult` per spec, with a
  //     deterministic stub value (`count` ⇒ `count`, fold ops ⇒ `value`).
  //   - `groupBy` requested → return a single synthetic group bucket keyed by a
  //     rendered label, carrying the per-group aggregates (same shape) and an
  //     empty `rows` page (the GROUPED contract).
  // The FLAT path (no `groupBy`) now evaluates the `FilterExpr` against every
  // active, in-space block via `metaRowMatchesExpr` (which reuses the
  // conformance-guarded per-primitive matrix), narrows to a `fulltext` MATCH
  // when one is present (a folded-substring test over the block's own
  // `content` — see `approximateFtsRank`'s docs for what that leaves out),
  // and orders the matched blocks via `resolveSortTerms` (#3837 — mirrors
  // `resolve_sort` in `agaric-store/src/query/engine.rs`: explicit `sort`
  // keys in request order, else `Relevance` when `fulltext` is present else
  // `b.id DESC`, always terminating in an `id` tiebreak), keyset-paginated.
  // This lets dev-preview + e2e exercise `AdvancedQueryView` against real
  // seed data instead of an always-empty page.
  run_advanced_query: (args) => {
    const request = ((args as Record<string, unknown>)['request'] ?? {}) as Record<string, unknown>
    const aggSpecs = (request['aggregates'] as Array<Record<string, unknown>> | undefined) ?? []
    const groupBy = request['groupBy'] as Record<string, unknown> | null | undefined
    const cursor = request['cursor'] as string | null | undefined

    // Echo one AggregateResult per requested spec. `count` lands in `count`;
    // every fold operator (sum/avg/min/max) lands a stub `value`.
    const aggregateResults = aggSpecs.map((spec, i) => {
      const op = spec['op'] as string
      if (op === 'count') return { op, value: null, count: i + 1 }
      return { op, value: (i + 1) * 10, count: null }
    })

    if (groupBy != null) {
      // First page only: synthesise one bucket. Cursor pages return an empty
      // tail so load-more terminates deterministically.
      if (cursor != null) {
        return { rows: [], groups: [], nextCursor: null, hasMore: false, totalCount: null }
      }
      const key = (groupBy['key'] as Record<string, unknown> | undefined) ?? {}
      const renderedKey = (key['type'] as string | undefined) ?? 'group'
      return {
        rows: [],
        groups: [
          {
            key: renderedKey,
            count: 1,
            members: [],
            ...(aggregateResults.length > 0 ? { aggregates: aggregateResults } : {}),
          },
        ],
        nextCursor: null,
        hasMore: false,
        totalCount: 1,
        ...(aggregateResults.length > 0 ? { aggregates: aggregateResults } : {}),
      }
    }

    // FLAT structural path: evaluate the `FilterExpr` against every active,
    // in-space block. An omitted filter defaults to the engine's TRUE
    // expression (`And { children: [] }`), so a filterless query returns the
    // whole space.
    const filterExpr = (request['filter'] as Record<string, unknown> | undefined) ?? {
      type: 'And',
      children: [],
    }
    const spaceId = request['spaceId'] as string
    const limit = Math.min(Number((request['limit'] as number | null | undefined) ?? 50), 100)
    // `fulltext`: an empty string is "no term", same convention as
    // `search_blocks`'s `!query` short-circuit.
    const fulltext = (request['fulltext'] as string | null | undefined) ?? ''
    const hasFulltext = fulltext.length > 0
    const foldedQuery = hasFulltext ? foldForSearch(fulltext) : ''
    const edges = deriveLinkEdges(blocks)
    const matched: MatchedEntry[] = []
    for (const b of blocks.values()) {
      if (b['deleted_at']) continue
      if (!fbqInSpace(b, spaceId)) continue
      // Page-aggregate primitives (child/inbound counts) need the block's own
      // page subtree; non-page blocks have no `page_id === id` descendants, so
      // those counts are 0 — matching the backend's per-row `b.*` evaluation.
      const descendants = Array.from(blocks.values()).filter(
        (d) => d['page_id'] === b['id'] && !d['deleted_at'] && d['id'] !== b['id'],
      )
      const row = buildPageMetaRow(b, descendants, edges)
      if (!metaRowMatchesExpr(row, filterExpr)) continue
      // Full-text narrowing: the engine INTERSECTS `fts_blocks MATCH ?` with
      // the structural predicate (`FROM fts_blocks fts JOIN blocks b …`).
      // The mock approximates the MATCH with a folded substring test over
      // the row's own content — see `approximateFtsRank`'s docs for what
      // that leaves out (referenced tag/page names, real FTS5 query syntax).
      if (hasFulltext && !matchesSearchFolded(row.content ?? '', fulltext)) continue
      matched.push({ b, row })
    }
    // #3837 — honour the request's `sort`, defaulting to relevance-first when
    // `fulltext` is present and to the `b.id DESC` recency keyset otherwise
    // (mirrors `resolve_sort` — see the comment above the handler).
    const sortKeys = (request['sort'] as Array<Record<string, unknown>> | undefined) ?? []
    const sortTerms = resolveSortTerms(sortKeys, hasFulltext, foldedQuery)
    matched.sort(compareByTerms(sortTerms))

    // Keyset cursor over the resolved sort order: skip up to AND INCLUDING
    // the anchor id.
    let startIdx = 0
    if (cursor != null) {
      let anchorId: string | null = null
      try {
        anchorId = (JSON.parse(atob(cursor)) as Record<string, unknown>)['id'] as string
      } catch {
        anchorId = null
      }
      if (anchorId != null) {
        const idx = matched.findIndex((m) => m.b['id'] === anchorId)
        if (idx >= 0) startIdx = idx + 1
      }
    }
    const slice = matched.slice(startIdx, startIdx + limit + 1)
    const hasMore = slice.length > limit
    const pageEntries = hasMore ? slice.slice(0, limit) : slice
    const pageRows = pageEntries.map((m) => m.b)
    const lastRow = pageEntries.at(-1)
    const nextCursor =
      hasMore && lastRow ? btoa(JSON.stringify({ id: lastRow.b['id'] as string })) : null
    return {
      rows: pageRows,
      nextCursor,
      hasMore,
      // total_count is first-page-only (null on cursor pages); the filtered-set
      // size is invariant across cursor pages, mirroring the pages handler.
      totalCount: cursor != null ? null : matched.length,
      ...(aggregateResults.length > 0 ? { aggregates: aggregateResults } : {}),
    }
  },

  search_blocks: (args) => {
    const a = args as Record<string, unknown>
    const query = (a['query'] as string) ?? ''
    if (!query) return { items: [], next_cursor: null, has_more: false, total_count: null }
    // Unicode-aware fold so the mock parity-matches the real
    // backend's FTS5 / `COLLATE NOCASE` behaviour for Turkish / German
    // / accented inputs.  Tests that assert Unicode matching against
    // the mock now see consistent behaviour.
    const items = [...blocks.values()].filter(
      (b) =>
        !(b['deleted_at'] as string | null) &&
        matchesSearchFolded((b['content'] as string) ?? '', query),
    )
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  search_blocks_partitioned: (args) => {
    // Phase 1 — partitions a single content-fold over `blocks`
    // into `pages` (block_type='page') and `blocks` (unrestricted). The
    // real backend caps each partition independently from one FTS scan;
    // the mock mirrors that wire shape on a folded-substring filter.
    const a = args as Record<string, unknown>
    const query = (a['query'] as string) ?? ''
    const pageLimit = (a['pageLimit'] as number) ?? 0
    const blockLimit = (a['blockLimit'] as number) ?? 0
    const empty = { items: [], next_cursor: null, has_more: false }
    if (!query) return { pages: empty, blocks: empty }

    const matching = [...blocks.values()].filter(
      (b) =>
        !(b['deleted_at'] as string | null) &&
        matchesSearchFolded((b['content'] as string) ?? '', query),
    )

    const pagesAll = matching.filter((b) => (b['block_type'] as string) === 'page')
    const pagesItems = pagesAll.slice(0, pageLimit)
    const blocksItems = matching.slice(0, blockLimit)

    return {
      pages: {
        items: pagesItems,
        next_cursor: null,
        has_more: pageLimit > 0 && pagesItems.length === pageLimit && pagesAll.length > pageLimit,
        total_count: null,
      },
      blocks: {
        items: blocksItems,
        next_cursor: null,
        has_more:
          blockLimit > 0 && blocksItems.length === blockLimit && matching.length > blockLimit,
        total_count: null,
      },
    }
  },

  list_unfinished_tasks: (args) => {
    const a = args as Record<string, unknown>
    const beforeDate = a['beforeDate'] as string
    const todoStates = a['todoStates'] as string[]
    const limit = (a['limit'] as number | null) ?? 200
    // Honour `scope: SpaceScope`. The previous mock read
    // `a['spaceId']`, which was the legacy IPC arg shape; the backend
    // now takes `scope: SpaceScope`, so callers in `tauri.ts` pass
    // `toSpaceScope(spaceId)` and the literal `spaceId` arg is no
    // longer present. Active scope: drop blocks whose owning page does
    // not carry `space = ?spaceId`. Global: unfiltered.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const items = Array.from(blocks.values()).filter((b) => {
      if (b['deleted_at']) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      if (!todoStates.includes((b['todo_state'] as string) ?? '')) return false
      const date = b['due_date'] ?? b['scheduled_date']
      if (!date || date >= beforeDate) return false
      return true
    })

    items.sort((rowA: Record<string, unknown>, rowB: Record<string, unknown>) => {
      const dateA = rowA['due_date'] ?? rowA['scheduled_date'] ?? ''
      const dateB = rowB['due_date'] ?? rowB['scheduled_date'] ?? ''
      if (dateA !== dateB) return (dateB as string).localeCompare(dateA as string)
      return (rowB['id'] as string).localeCompare(rowA['id'] as string)
    })

    return Promise.resolve({
      items: items.slice(0, limit),
      next_cursor: null,
      has_more: items.length > limit,
      total_count: null,
    })
  },

  // AND-intersected property + tag query that the
  // backend resolves entirely in SQL via composed `EXISTS` subqueries.
  // The mock exists so FE tests can assert the IPC fires and observe
  // the post-intersection result; cursor pagination is intentionally
  // skipped (the backend semantic the audit cares about is "no silent
  // row cap" / "single round-trip", not "the mock paginates").
  filtered_blocks_query: (args) => {
    const a = args as Record<string, unknown>
    const propertyFilters = (a['propertyFilters'] as Record<string, unknown>[] | null) ?? []
    const tagFilters = (a['tagFilters'] as Record<string, unknown> | null) ?? null
    const blockType = (a['blockType'] as string | null) ?? null
    // Honour `scope: SpaceScope` (mirrors `filtered_blocks_query_inner`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (blockType !== null && b['block_type'] !== blockType) return false
      if (!fbqInSpace(b, spaceId)) return false
      if (!propertyFilters.every((pf) => fbqPropertyFilterMatches(b, pf))) return false
      return fbqTagFilterMatches(b, tagFilters)
    })
    items.sort((x, y) => (x['id'] as string).localeCompare(y['id'] as string))
    return { items, next_cursor: null, has_more: false, total_count: null }
  },
} satisfies Pick<
  TypedHandlers,
  | 'run_advanced_query'
  | 'search_blocks'
  | 'search_blocks_partitioned'
  | 'list_unfinished_tasks'
  | 'filtered_blocks_query'
>
