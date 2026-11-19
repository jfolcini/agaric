/**
 * Tauri mock handlers -- search and query, as a thin stub (#6529).
 *
 * The specs that test what search and the query engine return run on the real
 * backend (the bridge), so the mock answers only what the UI needs to work:
 * search is a case-insensitive substring match on a block's text, and the
 * query commands evaluate tag and property filters. Results come in id order;
 * there is no ranking, sorting, search toggle, search filter or grouping.
 */

import {
  buildPageMetaRow,
  assertQueryFilterLeaves,
  fbqTagFilterMatches,
  listCandidates,
  metaRowMatchesExpr,
  ownerSpaceOf,
  pageRequestLimit,
  readActiveSpaceScope,
  type TypedHandlers,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blocks, properties } from '@/lib/tauri-mock/seed'

/** `MAX_SEARCH_RESULTS`: the search commands refuse a larger page. */
const SEARCH_MAX_RESULTS = 100

type Row = Record<string, unknown>

/** Live blocks in id order. */
function liveBlocks(): Row[] {
  return [...blocks.values()]
    .filter((b) => !b['deleted_at'])
    .toSorted((x, y) => (x['id'] as string).localeCompare(y['id'] as string))
}

/** Does the block's text (a page's title is its content) hold `query`, in any case? */
function holdsText(b: Row, query: string): boolean {
  return ((b['content'] as string | null) ?? '').toLowerCase().includes(query.toLowerCase())
}

/**
 * The spaces `SearchFilter.scope` names, or `null` for `all_spaces`. The
 * backend's `SearchScope` deserializer refuses an omitted scope and an empty
 * `spaces` list (#5415).
 */
function readSearchScope(filter: Row): string[] | null {
  const scope = filter['scope'] as { kind?: string; space_ids?: string[] } | undefined
  if (scope?.kind === 'all_spaces') return null
  if (scope?.kind !== 'spaces' || !scope.space_ids?.length) {
    throw validationRejection('search scope must be `all_spaces` or a non-empty `spaces` list')
  }
  return scope.space_ids
}

/** The live blocks in the search's scope whose text holds `query`; none for a blank query. */
function searchMatches(query: string, filter: Row): Row[] {
  const spaceIds = readSearchScope(filter)
  const needle = query.trim()
  if (needle === '') return []
  return liveBlocks().filter(
    (b) => (spaceIds === null || spaceIds.includes(ownerSpaceOf(b) ?? '')) && holdsText(b, needle),
  )
}

/** The page of id-ordered `rows` after `cursor`, which is the id of the last row served. */
function idPage(
  rows: Row[],
  cursor: string | null | undefined,
  limit: number,
): { items: Row[]; nextCursor: string | null; hasMore: boolean } {
  const rest = cursor == null ? rows : rows.filter((b) => (b['id'] as string) > cursor)
  const items = rest.slice(0, limit)
  const hasMore = rest.length > limit
  return { items, nextCursor: hasMore ? (items.at(-1)?.['id'] as string) : null, hasMore }
}

/** The block's values for `key`: its property's scalar and list items, or a reserved column. */
function heldPropertyValues(b: Row, key: string): string[] {
  const prop = properties.get(b['id'] as string)?.get(key)
  if (prop) {
    return [prop['value_text'], prop['value_date'], ...listCandidates(prop, false)].filter(
      (v): v is string => typeof v === 'string',
    )
  }
  const column = ['todo_state', 'priority', 'due_date', 'scheduled_date'].includes(key)
    ? b[key]
    : null
  return typeof column === 'string' ? [column] : []
}

/**
 * A `PropertyFilter` read as equality: the block holds `valueText`, `valueDate`
 * or one of `valueTextIn`, or with no value at all, holds the key. Any other
 * operator or a date range matches nothing.
 */
function propertyEquals(b: Row, pf: Row): boolean {
  if (((pf['operator'] as string | undefined) ?? 'eq').toLowerCase() !== 'eq') return false
  if (pf['valueDateRange'] != null) return false
  const held = heldPropertyValues(b, pf['key'] as string)
  const valueTextIn = (pf['valueTextIn'] as string[] | undefined) ?? []
  const wanted =
    valueTextIn.length > 0
      ? valueTextIn
      : [pf['valueText'], pf['valueDate']].filter((v): v is string => typeof v === 'string')
  return wanted.length === 0 ? held.length > 0 : held.some((v) => wanted.includes(v))
}

export const searchHandlers = {
  run_advanced_query: (args) => {
    const request = ((args as Row)['request'] ?? {}) as Row
    const cursor = request['cursor'] as string | null | undefined
    const filter = (request['filter'] as Row | undefined) ?? { type: 'And', children: [] }
    assertQueryFilterLeaves(filter)
    const limit = pageRequestLimit(request['limit'])
    if (request['groupBy'] != null) {
      return { rows: [], groups: [], nextCursor: null, hasMore: false, totalCount: 0 }
    }
    const fulltext = ((request['fulltext'] as string | null | undefined) ?? '').trim()
    const matched = liveBlocks().filter(
      (b) =>
        ownerSpaceOf(b) === request['spaceId'] &&
        metaRowMatchesExpr(buildPageMetaRow(b, [], []), filter) &&
        (fulltext === '' || holdsText(b, fulltext)),
    )
    const page = idPage(matched, cursor, limit)
    return {
      rows: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      totalCount: cursor == null ? matched.length : null,
    }
  },

  search_blocks: (args) => {
    const a = args as Row
    const limit = pageRequestLimit(a['limit'])
    if (limit > SEARCH_MAX_RESULTS) {
      throw validationRejection(`search limit must be in [1, ${SEARCH_MAX_RESULTS}]; got ${limit}`)
    }
    const matched = searchMatches((a['query'] as string | null) ?? '', (a['filter'] as Row) ?? {})
    const page = idPage(matched, a['cursor'] as string | null | undefined, limit)
    return {
      items: page.items,
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
      total_count: null,
    }
  },

  search_blocks_partitioned: (args) => {
    const a = args as Row
    const pageLimit = a['pageLimit'] as number
    const blockLimit = a['blockLimit'] as number
    const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n <= SEARCH_MAX_RESULTS
    if (!inRange(pageLimit) || !inRange(blockLimit)) {
      throw validationRejection(
        `partitioned search limits must each be in [0, ${SEARCH_MAX_RESULTS}]; ` +
          `got page_limit=${pageLimit}, block_limit=${blockLimit}`,
      )
    }
    const matched = searchMatches((a['query'] as string | null) ?? '', (a['filter'] as Row) ?? {})
    const partition = (rows: Row[], limit: number) => ({
      items: rows.slice(0, limit),
      next_cursor: null,
      has_more: rows.length > limit,
      total_count: null,
    })
    return {
      pages: partition(
        matched.filter((b) => b['block_type'] === 'page'),
        pageLimit,
      ),
      blocks: partition(matched, blockLimit),
    }
  },

  list_unfinished_tasks: (args) => {
    const a = args as Record<string, unknown>
    const beforeDate = a['beforeDate'] as string
    const todoStates = a['todoStates'] as string[]
    const limit = pageRequestLimit(a['limit'])
    // Honour `scope: SpaceScope`: drop blocks whose owning page does not
    // carry `space = ?spaceId`.
    const spaceId = readActiveSpaceScope('list_unfinished_tasks', a)

    const items = Array.from(blocks.values()).filter((b) => {
      if (b['deleted_at']) return false
      if (ownerSpaceOf(b) !== spaceId) return false
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

  filtered_blocks_query: (args) => {
    const a = args as Row
    const propertyFilters = (a['propertyFilters'] as Row[] | null) ?? []
    const tagFilters = (a['tagFilters'] as Row | null) ?? null
    const spaceId = readActiveSpaceScope('filtered_blocks_query', a)
    const limit = pageRequestLimit(a['limit'])
    const matched = liveBlocks().filter(
      (b) =>
        ownerSpaceOf(b) === spaceId &&
        propertyFilters.every((pf) => propertyEquals(b, pf)) &&
        fbqTagFilterMatches(b, tagFilters),
    )
    const page = idPage(matched, a['cursor'] as string | null | undefined, limit)
    return {
      items: page.items,
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
      total_count: null,
    }
  },
} satisfies Pick<
  TypedHandlers,
  | 'run_advanced_query'
  | 'search_blocks'
  | 'search_blocks_partitioned'
  | 'list_unfinished_tasks'
  | 'filtered_blocks_query'
>
