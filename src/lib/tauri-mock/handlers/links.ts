/**
 * Tauri mock handlers -- Backlinks, unlinked references, and the page-link graph.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

// #4022 — the `fts_blocks.stripped` stand-in, imported rather than re-spelled:
// `search.ts` is its single owner (#3938), and a second copy of the strip /
// fold pair here would be free to drift away from the index it models.
// #4667 — `get_backlinks` pages the SAME way `list_blocks`'s three
// `ORDER BY id ASC` branches do (`Cursor::for_id`, `LIMIT ?limit + 1`), so it
// reuses their paginator rather than growing a second cursor codec that would
// be free to drift from the backend's `Cursor` shape.
import { compareUtf8Bytes } from '@/lib/sqlite-collation'
import { idKey, paginateKeyset } from '@/lib/tauri-mock/handlers/blocks'
import { matchesFtsIndex, stripForFts } from '@/lib/tauri-mock/handlers/search'
import {
  type TypedHandlers,
  columnBackedValue,
  createdInRange,
  datePredicateMatches,
  fbqResolvePrefixTagIds,
  inSpaceScope,
  linkKind,
  linksTo,
  ownerSpaceOf,
  pageRequestLimit,
  propertyCompareMatches,
  propertyEqMatches,
  propertyLikeMatches,
  refInclusiveTags,
  resolveRangeBound,
  scanLinkTargets,
  readActiveSpaceScope,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { blockTags, blocks, linkMetadata, pageAliases, properties } from '@/lib/tauri-mock/seed'

/** Does `b` hold `key`: a `block_properties` row, or a set column for a
 *  column-backed key (#6051)? */
function holdsProperty(b: Record<string, unknown>, key: string): boolean {
  const column = columnBackedValue(b, key)
  if (column !== undefined) return column !== null
  return properties.get(b['id'] as string)?.has(key) ?? false
}

/**
 * Narrow a backlink candidate set by `BacklinkFilter`s, AND-joined, as
 * `compile_backlink_filters` does for `eval_backlink_query_grouped` on the
 * backend (`agaric-store/src/backlink/filters.rs`). Pinned by
 * `conformance/fixtures/query_backlinks_grouped_filters.json` and
 * `query_not_over_leaves.json`.
 */
function applyBacklinkFilters(
  items: Record<string, unknown>[],
  filterList: Array<Record<string, unknown>>,
): Record<string, unknown>[] {
  // The backend answers an empty candidate set before it compiles the filters.
  if (items.length === 0) return items
  for (const f of filterList) assertBacklinkFilter(f)
  return items.filter((b) => filterList.every((f) => matchesBacklinkFilter(b, f)))
}

/**
 * The refusals `compile_backlink_filter` raises while compiling, before any row
 * is read: a `DueDate` `Contains` / `StartsWith` and a malformed
 * `CreatedInRange` bound, anywhere in the tree.
 */
function assertBacklinkFilter(filter: Record<string, unknown>): void {
  switch (filter['type'] as string) {
    case 'DueDate': {
      dueDatePredicate(filter)
      return
    }
    case 'CreatedInRange': {
      resolveRangeBound(filter['after'])
      resolveRangeBound(filter['before'])
      return
    }
    case 'And':
    case 'Or': {
      for (const f of filter['filters'] as Array<Record<string, unknown>>) assertBacklinkFilter(f)
      return
    }
    case 'Not': {
      assertBacklinkFilter(filter['filter'] as Record<string, unknown>)
    }
  }
}

/** `CompareOp` → `DatePredicate` for the `DueDate` leaf (`compare_op_to_date_predicate`). */
const DUE_DATE_PREDICATES: Readonly<Record<string, string>> = {
  Eq: 'On',
  Lt: 'Before',
  Lte: 'OnOrBefore',
  Gt: 'After',
  Gte: 'OnOrAfter',
}

/**
 * The `DueDate` leaf's predicate over `b.due_date`. `Neq` is
 * `(b.due_date != ? AND b.due_date IS NOT NULL)`, which has no `DatePredicate`;
 * `Contains` / `StartsWith` are refused.
 */
function dueDatePredicate(filter: Record<string, unknown>): (due: string | null) => boolean {
  const op = filter['op'] as string
  const date = filter['value'] as string
  if (op === 'Neq') return (due) => due != null && due !== date
  const type = DUE_DATE_PREDICATES[op]
  if (type === undefined) {
    throw validationRejection(`DueDate filter does not support ${op} operator`)
  }
  return (due) => datePredicateMatches(due, { type, date })
}

/** Which `block_properties` value type each property leaf compares. */
const PROPERTY_LEAF_VALUE_TYPES: Readonly<Record<string, string>> = {
  PropertyText: 'Text',
  PropertyNum: 'Num',
  PropertyDate: 'Date',
}

/**
 * `PropertyText` / `PropertyNum` / `PropertyDate` (`prop_cmp`): `EXISTS (… key = ?
 * AND value_<type> IS NOT NULL AND value_<type> <op> ?)`, so a block without the
 * property matches under no operator, `Neq` included. A column-backed key
 * compares its column as text whatever the leaf's type (`compile_column_property`).
 * `Contains` / `StartsWith` on a number match nothing.
 */
function propertyLeafMatches(b: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  const key = filter['key'] as string
  const op = filter['op'] as string
  const column = columnBackedValue(b, key)
  const prop =
    column === undefined
      ? (properties.get(b['id'] as string)?.get(key) ?? null)
      : column === null
        ? null
        : { value_text: column }
  const value =
    column === undefined
      ? { type: PROPERTY_LEAF_VALUE_TYPES[filter['type'] as string], value: filter['value'] }
      : { type: 'Text', value: String(filter['value']) }
  switch (op) {
    case 'Eq': {
      return propertyEqMatches(prop, value)
    }
    case 'Neq': {
      // `<>` over a non-NULL value is `<` or `>`.
      return propertyCompareMatches(prop, 'Lt', value) || propertyCompareMatches(prop, 'Gt', value)
    }
    case 'Contains':
    case 'StartsWith': {
      return propertyLikeMatches(prop, op === 'Contains', value)
    }
    default: {
      return propertyCompareMatches(prop, op, value)
    }
  }
}

function matchesBacklinkFilter(
  b: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  const id = b['id'] as string
  switch (filter['type'] as string) {
    case 'BlockType': {
      return b['block_type'] === filter['block_type']
    }
    case 'TodoState': {
      return b['todo_state'] === filter['state']
    }
    case 'Priority': {
      return b['priority'] === filter['level']
    }
    case 'Contains': {
      const query = (filter['query'] as string) ?? ''
      // #4022 — `BacklinkFilter::Contains` is `sanitize_fts_query` + `WHERE
      // fts_blocks MATCH ?1` (`agaric-store/src/backlink/filters.rs:381-421`,
      // SQL at :398-407). It is NOT a `LIKE` scan over `blocks.content`: it
      // reads the SAME trigram index `search_blocks` does, so it matches
      // `stripForFts`'s text through the index's case-only fold. This was
      // `matchesSearchFolded` over raw content, which both over-matched
      // (folding diacritics the tokenizer does not fold) and under-matched
      // (blind to markup-hidden terms and to the names `#[ULID]` /
      // `[[ULID]]` resolve to).
      //
      // One query-SIDE divergence is left standing, and is named rather than
      // modelled: the backend early-returns an EMPTY result set when
      // `query.trim().is_empty()` or the query sanitizes to empty
      // (`src-tauri/agaric-store/src/backlink/filters.rs:382-388` / `:955-962`), where `matchesFtsIndex` admits
      // every candidate for an empty needle. Note the backend TRIMS, so this
      // covers two shapes — `''` (which `matchesFtsIndex` short-circuits to
      // "match all") and whitespace-only such as `'   '` (which it runs as a
      // three-space substring test). Both are the pre-#4022 behaviour here,
      // unchanged by this seam, and both are reachable from this call site
      // because it does not test blank-ness first.
      return matchesFtsIndex(stripForFts(b['content'] as string | null), query)
    }
    case 'PropertyText':
    case 'PropertyNum':
    case 'PropertyDate': {
      return propertyLeafMatches(b, filter)
    }
    case 'DueDate': {
      return dueDatePredicate(filter)((b['due_date'] as string | null | undefined) ?? null)
    }
    case 'CreatedInRange': {
      return createdInRange(id, filter['after'], filter['before'])
    }
    case 'PropertyIsSet': {
      return holdsProperty(b, filter['key'] as string)
    }
    case 'PropertyIsEmpty': {
      return !holdsProperty(b, filter['key'] as string)
    }
    case 'HasTag': {
      return refInclusiveTags(id).has(filter['tag_id'] as string)
    }
    case 'HasTagPrefix': {
      const tags = refInclusiveTags(id)
      return fbqResolvePrefixTagIds([filter['prefix'] as string]).some((t) => tags.has(t))
    }
    case 'SourcePage': {
      return inSourcePages(b, filter['included'] as string[], filter['excluded'] as string[])
    }
    // An empty `And` / `Or` is the empty set (`1=0`), not the neutral element.
    case 'And': {
      const filters = filter['filters'] as Array<Record<string, unknown>>
      return filters.length > 0 && filters.every((f) => matchesBacklinkFilter(b, f))
    }
    case 'Or': {
      return (filter['filters'] as Array<Record<string, unknown>>).some((f) =>
        matchesBacklinkFilter(b, f),
      )
    }
    case 'Not': {
      return !matchesBacklinkFilter(b, filter['filter'] as Record<string, unknown>)
    }
    default: {
      throw validationRejection(`unknown variant \`${String(filter['type'])}\``)
    }
  }
}

/** The `SourcePage` leaf: under an included page (any, when none is named) and no excluded one. */
function inSourcePages(
  b: Record<string, unknown>,
  included: string[],
  excluded: string[],
): boolean {
  return (
    (included.length === 0 || descendsFrom(b, new Set(included))) &&
    !descendsFrom(b, new Set(excluded))
  )
}

/**
 * Whether `b` is one of `roots` or their descendant through live blocks, as the
 * leaf's recursive CTE walks them, bounded at `depth < 100`.
 */
function descendsFrom(b: Record<string, unknown>, roots: ReadonlySet<string>): boolean {
  let cur: Record<string, unknown> | undefined = b
  for (let depth = 0; cur !== undefined && !cur['deleted_at'] && depth <= 100; depth++) {
    if (roots.has(cur['id'] as string)) return true
    const parentId = cur['parent_id'] as string | null
    cur = parentId === null ? undefined : blocks.get(parentId)
  }
  return false
}

/**
 * The `total_count` universe: sources whose root page exists and is not the
 * target's own (an orphan or a self-reference counts nowhere).
 */
function countedSources(
  sources: Record<string, unknown>[],
  targetPageId: string,
): Record<string, unknown>[] {
  return sources.filter((b) => {
    const pid = b['page_id'] as string | null
    return pid !== null && pid !== targetPageId && blocks.has(pid)
  })
}

/**
 * The `GroupedBacklinkResponse` both grouped readers answer with, built the
 * way `eval_backlink_query_grouped` and `eval_unlinked_references` build
 * theirs (`agaric-store/src/backlink/grouped.rs`).
 *
 * #4667 — found by `query_backlinks_grouped.json`. This used to be two copies
 * that grouped by `parent_id`, kept the target page's own blocks, listed
 * groups in insertion order and ignored `limit` and `cursor`. The backend:
 *
 *   * keys a group by the source's ROOT page (`blocks.page_id`) and drops a
 *     source on the TARGET's root page as a self-reference — from the groups
 *     and from both counts;
 *   * orders groups by `(page_title, page_id)` (`cmp_group`) whatever the
 *     user's sort, which orders MEMBERS only ({@link compareBacklinkMembers});
 *   * counts `limit` in GROUPS and mints `Cursor::for_group`: `page_id` in
 *     `id`, `page_title` in the `deleted_at` slot;
 *   * for the backlink reader only, answers `total_count: 0` /
 *     `filtered_count: 0` on a cursor page (#2201 item 1b — its two COUNTs
 *     run on the first page, and the UI keeps that page's numbers). The
 *     unlinked reader recomputes both on every page, and
 *     `useUnlinkedReferences` reads them from the LAST page.
 *
 * `sources` is the base set BEFORE the user's `filters` (the `total_count`
 * universe); `filters` narrow it to the `filtered_count` one. `truncated` is
 * the `MAX_BLOCKS_PER_GROUP` cap per group and the FTS row cap on the
 * envelope; neither is reachable from a mock fixture.
 */
function groupedBacklinkResponse(
  sources: Record<string, unknown>[],
  targetPageId: string,
  a: Record<string, unknown>,
  counts: 'first-page-only' | 'every-page',
  limit: number,
): {
  groups: Record<string, unknown>[]
  next_cursor: string | null
  has_more: boolean
  total_count: number
  filtered_count: number
  truncated: boolean
} {
  const base = countedSources(sources, targetPageId)
  const filterList = (a['filters'] as Array<Record<string, unknown>> | null) ?? []
  const filtered = applyBacklinkFilters(base, filterList)
  const byPage = new Map<string, Record<string, unknown>[]>()
  const sort = (a['sort'] as Record<string, unknown> | null | undefined) ?? null
  for (const b of filtered.toSorted(compareBacklinkMembers(sort))) {
    const pid = b['page_id'] as string
    const group = byPage.get(pid)
    if (group === undefined) byPage.set(pid, [b])
    else group.push(b)
  }
  const groups = [...byPage].map(([page_id, items]) => ({
    page_id,
    // `base` already requires the root page to exist; `blocks.content` is
    // nullable, so the title can still be null.
    page_title: (blocks.get(page_id)?.['content'] as string | null | undefined) ?? null,
    blocks: items,
    truncated: false,
  }))
  const page = paginateKeyset(
    groups,
    // `cmp_group` sorts a `None` title LAST, which the `null` component of a
    // `SortKey` is, through the cursor as well.
    (g) => [g['page_title'] as string | null, g['page_id'] as string],
    limit,
    a['cursor'],
    null,
    ['deleted_at'],
  )
  const recount = counts === 'every-page' || a['cursor'] == null
  return {
    groups: page.items,
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    total_count: recount ? base.length : 0,
    filtered_count: recount ? filtered.length : 0,
    truncated: false,
  }
}

/** The keys a property sort reads from their `blocks` column (`is_reserved_property_key`). */
const RESERVED_SORT_KEYS: ReadonlySet<string> = new Set([
  'todo_state',
  'priority',
  'due_date',
  'scheduled_date',
])

/**
 * `sort_ids` (`agaric-store/src/backlink/sort.rs`). No sort is `Created { Asc }`;
 * `Created` is id order in either direction. A property sort orders by its
 * variant's value column, or by the `blocks` column for a reserved key,
 * `NULLS LAST` in both directions, ties by id ascending.
 */
function compareBacklinkMembers(
  sort: Record<string, unknown> | null,
): (x: Record<string, unknown>, y: Record<string, unknown>) => number {
  const byId = (x: Record<string, unknown>, y: Record<string, unknown>): number =>
    compareUtf8Bytes(x['id'] as string, y['id'] as string)
  const desc = sort?.['dir'] === 'Desc'
  if (sort === null || sort['type'] === 'Created') {
    return (x, y) => (desc ? -byId(x, y) : byId(x, y))
  }
  const key = sort['key'] as string
  const column =
    sort['type'] === 'PropertyNum'
      ? 'value_num'
      : sort['type'] === 'PropertyDate'
        ? 'value_date'
        : 'value_text'
  const valueOf = (row: Record<string, unknown>): string | number | null =>
    ((RESERVED_SORT_KEYS.has(key)
      ? row[key]
      : properties.get(row['id'] as string)?.get(key)?.[column]) as string | number | null) ?? null
  return (x, y) => {
    const a = valueOf(x)
    const b = valueOf(y)
    if (a === null || b === null) {
      if (a === b) return byId(x, y)
      return a === null ? 1 : -1
    }
    const order =
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : compareUtf8Bytes(String(a), String(b))
    if (order === 0) return byId(x, y)
    return desc ? -order : order
  }
}

/**
 * The unlinked-references base set before the user's filters (both unlinked
 * readers start from it), or `null` when neither the title nor an alias yields
 * a needle — the backend's early return.
 */
function unlinkedSources(pageId: string, spaceId: string): Record<string, unknown>[] | null {
  // #4159 item 3 — the TITLE lookup is guarded:
  // `SELECT content FROM blocks WHERE id = ?1 AND block_type = 'page' AND
  // deleted_at IS NULL` (`agaric-store/src/backlink/grouped.rs:588-591`),
  // and the guard is there so a conflict-copy page id never resolves to a
  // title that drives the search. `fetch_optional` answering `None` is not
  // an early return on the backend: `title` falls back to the empty string
  // (`:594-598`) and the ALIAS half still runs. So a `pageId` naming a
  // content block or a soft-deleted page contributes NO title term here,
  // exactly as it contributes none there — while a live alias row on that
  // same id still searches, because `SELECT alias FROM page_aliases WHERE
  // page_id = ?1` (`:601-605`) carries neither predicate on either side.
  //
  // This replaces a `blocks.get(pageId)` that applied neither predicate AND
  // early-returned on a miss, so it was wrong in both directions: a
  // content-block id searched on that block's text, and an id with only an
  // alias row answered empty.
  const page = blocks.get(pageId)
  const pageTitle =
    page && page['block_type'] === 'page' && !page['deleted_at']
      ? ((page['content'] as string | null) ?? '')
      : ''
  // #4036 item 1 — the needle set is the page TITLE **OR** every one of its
  // `page_aliases` rows, not the title alone. `eval_unlinked_references`
  // builds `terms` from the sanitized title and then from each sanitized,
  // trimmed alias, and ORs them into one FTS5 query — `(t1) OR (t2) …`
  // (`agaric-store/src/backlink/grouped.rs:598-645`). A block reading "see
  // getting-started for setup" is an unlinked reference to the
  // `getting-started`-aliased page on the backend; here it was a false
  // negative, and not hypothetically — `pageAliases` is a seeded store
  // (`src/lib/tauri-mock/seed.ts:653`).
  //
  // The `trim()` on each term is the backend's own (`alias.trim()`,
  // grouped.rs:614) plus, for the title, the `sanitize_fts_query` empty
  // check: a whitespace-only title contributes NO term, so it neither
  // early-returns on its own nor runs as a literal substring needle that
  // would match every block containing a space. The early return fires only
  // when the COMBINED term list is empty (grouped.rs:625-635) — a blank
  // title with a live alias still searches.
  const terms = [pageTitle, ...(pageAliases.get(pageId) ?? [])]
    .map((t) => t.trim())
    .filter((t) => t !== '')
  if (terms.length === 0) return null
  // Find blocks that mention the page title as text but don't have a [[link]].
  //
  // #4022 — `eval_unlinked_references` runs `WHERE fts_blocks MATCH ?1`
  // (`agaric-store/src/backlink/grouped.rs:682-697`) over the sanitized
  // title, so the haystack is `fts_blocks.stripped` ({@link stripForFts})
  // and the fold is the trigram tokenizer's case-only one
  // ({@link matchesFtsIndex}) — the same index `search_blocks` reads, not a
  // `LIKE` scan over `blocks.content`. This was `matchesSearchFolded` over
  // raw content, which surfaced diacritic-folded mentions the backend never
  // returns and missed mentions hidden behind markup or supplied by a
  // resolved `[[ULID]]` title.
  return [...blocks.values()].filter((b) => {
    if (b['deleted_at']) return false
    // `AND b.block_type != 'page'` (grouped.rs:688) — title blocks are
    // dropped from the base set GLOBALLY, not just for descendants of this
    // page. The trigram tokenizer is substring-based, so a child page
    // `Notes/2026` would otherwise surface as an unlinked reference to
    // `Notes` via the trigrams `Not` / `ote` / `tes`; the refs panel
    // surfaces body matches, not title matches.
    if (b['block_type'] === 'page') return false
    if (!inSpaceScope(b, spaceId)) return false
    const content = (b['content'] as string) ?? ''
    // The FTS5 `OR` over `terms` — ANY term hitting keeps the row.
    const stripped = stripForFts(content)
    if (!terms.some((t) => matchesFtsIndex(stripped, t))) return false
    // Exclude if it already has a [[link]] to this page.
    return !linksTo(b, pageId)
  })
}

/** A no-groups `GroupedBacklinkResponse` carrying `count` in both counts. */
function countOnlyResponse(count: number) {
  return {
    groups: [],
    next_cursor: null,
    has_more: false,
    total_count: count,
    filtered_count: count,
    truncated: false,
  }
}

export const linksHandlers = {
  get_backlinks: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    // Honour `scope: SpaceScope` the same way the backend's
    // `get_backlinks_inner` does: drop source blocks whose owning page
    // (`page_id`, or own id if itself a page) lives in a different space.
    const spaceId = readActiveSpaceScope('get_backlinks', a)
    // Every block holding an edge to the target (`linksTo`, over the single
    // owner of the token grammar, #3332).
    const backlinkItems = [...blocks.values()].filter(
      (b) => !b['deleted_at'] && inSpaceScope(b, spaceId) && linksTo(b, targetId),
    )
    // #4667 — this used to return the WHOLE set with `has_more: false` and no
    // cursor, ignoring `limit` and `cursor` outright, so every page was the
    // first page. `pagination::list_backlinks` is `ORDER BY bl.source_id ASC
    // LIMIT ?limit + 1` over an `{id}` keyset; `bl.source_id` is the source
    // block's own id, which is what {@link idKey} reads. Found by the
    // `query_backlinks.json` query steps.
    return paginateKeyset(backlinkItems, idKey, pageRequestLimit(a['limit']), a['cursor'], null, [])
  },

  count_backlinks_batch: (args) => {
    const a = args as Record<string, unknown>
    const pageIds = a['pageIds'] as string[]
    // Honour `scope` so mock-mode FE tests can
    // observe space-scoped badge counts the same way the real backend
    // produces them.
    const spaceId = readActiveSpaceScope('count_backlinks_batch', a)
    const result: Record<string, number> = {}
    for (const pid of pageIds) {
      // Active-space scoping (`inSpaceScope`) drops source blocks whose owning
      // page doesn't carry `space = <spaceId>` — the SQL
      // `COALESCE(b.page_id, b.id) IN (... space ...)` predicate
      // `count_backlinks_batch_inner` uses.
      const count = [...blocks.values()].filter(
        (b) => !b['deleted_at'] && inSpaceScope(b, spaceId) && linksTo(b, pid),
      ).length
      // #3830 — a page nothing links to is ABSENT, not 0: the backend's `GROUP
      // BY bl.target_id` never emits an empty group (callers default `?? 0`).
      if (count > 0) result[pid] = count
    }
    return result
  },

  list_backlinks_grouped: (args) => {
    const a = args as Record<string, unknown>
    const targetId = a['blockId'] as string
    const limit = pageRequestLimit(a['limit'])
    // Honour `scope: SpaceScope` (mirrors
    // `list_backlinks_grouped_inner`).
    const spaceId = readActiveSpaceScope('list_backlinks_grouped', a)
    // #4551 — `AND (? IS NULL OR bl.kind = ?)`, the kind the reindex stored.
    const kind = (a['kind'] as string | null | undefined) ?? null
    const sources = [...blocks.values()].filter(
      (b) =>
        !b['deleted_at'] &&
        inSpaceScope(b, spaceId) &&
        linksTo(b, targetId) &&
        (kind === null || linkKind(b, targetId) === kind),
    )
    // `COALESCE(tgt.page_id, tgt.id)` — the target's root page, whose own
    // blocks are self-references.
    const targetPageId = (blocks.get(targetId)?.['page_id'] as string | null) ?? targetId
    return groupedBacklinkResponse(sources, targetPageId, a, 'first-page-only', limit)
  },

  list_unlinked_references: (args) => {
    const a = args as Record<string, unknown>
    const pageId = a['pageId'] as string
    // `PageRequest::new` runs before the title lookup on the backend, so an
    // out-of-range limit is refused on BOTH exits, the empty-needle one too.
    const limit = pageRequestLimit(a['limit'])
    // Honour `scope: SpaceScope` (mirrors
    // `list_unlinked_references_inner`).
    const spaceId = readActiveSpaceScope('list_unlinked_references', a)
    const unlinked = unlinkedSources(pageId, spaceId)
    if (unlinked === null) return countOnlyResponse(0)
    return groupedBacklinkResponse(unlinked, pageId, a, 'every-page', limit)
  },

  // #5422 — `count_unlinked_references_inner`: the list reader's unfiltered
  // counts with no groups, for the collapsed panel.
  count_unlinked_references: (args) => {
    const a = args as Record<string, unknown>
    const pageId = a['pageId'] as string
    const spaceId = readActiveSpaceScope('count_unlinked_references', a)
    const unlinked = unlinkedSources(pageId, spaceId)
    return countOnlyResponse(unlinked === null ? 0 : countedSources(unlinked, pageId).length)
  },

  // ---------------------------------------------------------------------------
  // Word-level diff for history display
  // ---------------------------------------------------------------------------

  list_page_links: (args) => {
    // Scan all non-deleted blocks for [[ULID]] page link tokens and
    // return page-to-page edges (source = parent page, target = linked page).
    const a = (args as Record<string, unknown> | null | undefined) ?? {}
    // When `tagIds` is non-empty, restrict edges to
    // those whose target page carries at least one of the listed tags.
    // Mirrors the backend semantics (`block_tags`-only resolution in the
    // mock world; the real backend additionally unions
    // `block_tag_inherited` / `block_tag_refs`, which the mock does not
    // model — see seed.ts).
    const rawTagIds = a['tagIds'] as string[] | null | undefined
    const tagFilter = rawTagIds && rawTagIds.length > 0 ? new Set(rawTagIds) : null
    // Honour `scope: SpaceScope` (mirrors `list_page_links_inner`).
    // Both endpoints of an edge must live in the active space. Matches the
    // backend's `b1.space = ?` AND `b2.space = ?` join predicate.
    const spaceId = readActiveSpaceScope('list_page_links', a)
    const pageSpace = (pid: string): string | null => ownerSpaceOf({ id: pid })
    const linkSet = new Set<string>()
    const pageLinks: Array<{ source_id: string; target_id: string; ref_count: number }> = []
    for (const b of blocks.values()) {
      if (b['deleted_at']) continue
      const parentId = b['parent_id'] as string | null
      if (!parentId) continue
      // Only consider blocks whose parent is a page
      const parentBlock = blocks.get(parentId)
      if (!parentBlock || parentBlock['block_type'] !== 'page') continue
      // Active-scope filter on source page.
      if (pageSpace(parentId) !== spaceId) continue
      const content = (b['content'] as string) ?? ''
      for (const targetPageId of scanLinkTargets(content)) {
        // `plc.source_page_id != plc.target_page_id`: a page's link to itself
        // is no edge of the graph.
        if (!linksTo(b, targetPageId) || targetPageId === parentId) continue
        // Ensure target is an existing non-deleted page
        const targetBlock = blocks.get(targetPageId)
        if (!targetBlock || targetBlock['block_type'] !== 'page' || targetBlock['deleted_at'])
          continue
        // Active-scope filter on target page (mirrors the
        // backend's `b2.space = ?` predicate).
        if (pageSpace(targetPageId) !== spaceId) continue
        // Apply target-side tag filter.
        if (tagFilter) {
          const targetTags = blockTags.get(targetPageId)
          let hit = false
          if (targetTags) {
            for (const tid of tagFilter) {
              if (targetTags.has(tid)) {
                hit = true
                break
              }
            }
          }
          if (!hit) continue
        }
        // Deduplicate edges
        const key = `${parentId}→${targetPageId}`
        if (!linkSet.has(key)) {
          linkSet.add(key)
          pageLinks.push({ source_id: parentId, target_id: targetPageId, ref_count: 1 })
        }
      }
    }
    // #2298 count-then-cap — the real backend ships a `PageLinksResponse`
    // envelope. The mock world never caps, so `total` is always the full
    // edge count and `truncated` is always false.
    return { edges: pageLinks, total: pageLinks.length, truncated: false }
  },

  // ---------------------------------------------------------------------------
  // Logging commands (fire-and-forget)
  // ---------------------------------------------------------------------------

  // There is no network here, so the "fetch" answers a stub and upserts it
  // into `linkMetadata` so the read below sees the url afterwards. It does
  // not mirror `fetch_link_metadata_inner`'s seven-day freshness short-circuit
  // (a fresh cached row is returned untouched there); the command stays
  // waived, and the frontend only fetches after a `get` miss.
  fetch_link_metadata: (args) => {
    const a = args as Record<string, unknown>
    const url = a['url'] as string
    const row = {
      url,
      title: 'Mock Title',
      favicon_url: null,
      description: null,
      fetched_at: Date.now(),
      auth_required: false,
      not_found: false,
    }
    linkMetadata.set(url, row)
    return row
  },

  // `get_link_metadata_inner` is `link_metadata::get_cached`: the stored row
  // for a seen url, `null` for an unseen one. The mock answered the fetch stub
  // for ANY url until `query_link_metadata.json` pinned the miss (#3830).
  get_link_metadata: (args) => {
    const a = args as Record<string, unknown>
    return linkMetadata.get(a['url'] as string) ?? null
  },

  // ---------------------------------------------------------------------------
  // MCP read-only / read-write servers
  //
  // The real backend manages a Unix-domain-socket lifecycle that can't run
  // inside Playwright. The mock returns disabled status snapshots so
  // AgentAccessSettingsTab renders its toggles + socket-path readouts
  // without per-call stubbing. Toggle commands echo the requested value;
  // disconnect commands return `null` since they have no observable
  // effect on the mock state.
  // ---------------------------------------------------------------------------
} satisfies Pick<
  TypedHandlers,
  | 'get_backlinks'
  | 'count_backlinks_batch'
  | 'list_backlinks_grouped'
  | 'list_unlinked_references'
  | 'count_unlinked_references'
  | 'list_page_links'
  | 'fetch_link_metadata'
  | 'get_link_metadata'
>
