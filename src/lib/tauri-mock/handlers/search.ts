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

import { matchesSearchFolded } from '@/lib/fold-for-search'
import {
  type TypedHandlers,
  buildPageMetaRow,
  deriveLinkEdges,
  fbqInSpace,
  fbqPropertyFilterMatches,
  fbqTagFilterMatches,
  metaRowMatchesExpr,
} from '@/lib/tauri-mock/handlers/shared'
import { blocks, properties } from '@/lib/tauri-mock/seed'

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
  // conformance-guarded per-primitive matrix) and returns the matched blocks in
  // the engine's `b.id ASC` keyset-tiebreaker order, keyset-paginated. The mock
  // applies the tiebreaker only — full `SortKey` ordering is a follow-up — but
  // this lets dev-preview + e2e exercise `AdvancedQueryView` against real seed
  // data instead of an always-empty page.
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
    const edges = deriveLinkEdges(blocks)
    const matched: Record<string, unknown>[] = []
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
      if (metaRowMatchesExpr(row, filterExpr)) matched.push(b)
    }
    // Stable `b.id ASC` keyset order (the engine's terminal tiebreaker).
    matched.sort((x, y) => (x['id'] as string).localeCompare(y['id'] as string))

    // Keyset cursor over the id order: skip up to AND INCLUDING the anchor id.
    let startIdx = 0
    if (cursor != null) {
      let anchorId: string | null = null
      try {
        anchorId = (JSON.parse(atob(cursor)) as Record<string, unknown>)['id'] as string
      } catch {
        anchorId = null
      }
      if (anchorId != null) {
        const idx = matched.findIndex((b) => b['id'] === anchorId)
        if (idx >= 0) startIdx = idx + 1
      }
    }
    const slice = matched.slice(startIdx, startIdx + limit + 1)
    const hasMore = slice.length > limit
    const pageRows = hasMore ? slice.slice(0, limit) : slice
    const lastRow = pageRows.at(-1)
    const nextCursor =
      hasMore && lastRow ? btoa(JSON.stringify({ id: lastRow['id'] as string })) : null
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
