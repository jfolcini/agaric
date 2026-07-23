import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { PageResponse, PartitionedSearchResponse, SearchBlockRow } from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'
import { requireActiveScope } from '@/lib/tauri/_shared'
import { withAbort } from '@/lib/tauri/core'

/** Full-text search across all blocks, paginated by relevance.
 *
 * `spaceId` (Phase 4) — required. Restricts matches to blocks
 * whose owning page carries `space = <spaceId>`. Callers must resolve
 * the active `currentSpaceId` (from `useSpaceStore`) before invoking;
 * pre-bootstrap callers should pass `''` (empty string), which the
 * backend treats as a no-match (returns an empty page) rather than
 * crashing on a runtime null deref.
 *
 * Phase 0 — `parentId`, `tagIds`, `spaceId` are marshalled into
 * the backend's `SearchFilter` struct at the IPC boundary. The public
 * API stays flat so existing call sites (e.g. `SearchPanel.tsx`) do
 * Not need to change. Follow-up plans (54 / 55 / 53) append
 * new filter fields here; the wrapper forwards each into the struct.
 *
 * Phase 1 — responses now carry `SearchBlockRow` (which adds
 * `snippet: string | null`). The shape is a strict superset of
 * `BlockRow`, so existing consumers compile unchanged.
 */
export async function searchBlocks(
  params: {
    query: string
    parentId?: string | undefined
    tagIds?: string[] | undefined
    cursor?: string | undefined
    limit?: SafeLimit | undefined
    spaceId: string
    /** page-name glob include list. See `SearchFilter`. */
    includePageGlobs?: string[] | undefined
    /** page-name glob exclude list. See `SearchFilter`. */
    excludePageGlobs?: string[] | undefined
    /** case-sensitive post-FTS filter. See `SearchFilter`. */
    caseSensitive?: boolean | undefined
    /** ASCII whole-word post-FTS filter. See `SearchFilter`. */
    wholeWord?: boolean | undefined
    /** regex-mode (bypasses FTS5). See `SearchFilter`. */
    isRegex?: boolean | undefined
    /**
     * Restrict to a specific `blocks.block_type` (e.g. `'page'`).
     * The Cmd+K palette fires a page-only query in parallel with an
     * unrestricted blocks query so the FE only has to merge by `page_id`.
     * `undefined` preserves the pre-existing "all block types" behaviour.
     * See `SearchFilter.block_type_filter`.
     */
    blockTypeFilter?: string | undefined
    /** `blocks.todo_state IN (...)`. See `SearchFilter`. */
    stateFilter?: string[] | undefined
    /** `blocks.priority IN (...)`. See `SearchFilter`. */
    priorityFilter?: string[] | undefined
    /**
     * Date predicate on `blocks.due_date`. The frontend AST
     * carries `DateFilterValue` with operators `< <= = >= >`; this
     * wrapper translates to the wire shape `{ named: ... } | { op: {
     * op: 'lt' | 'lte' | 'eq' | 'gte' | 'gt', date } }`.
     */
    dueFilter?: DateFilterValueInput | null | undefined
    /** same shape as `dueFilter` but on `blocks.scheduled_date`. */
    scheduledFilter?: DateFilterValueInput | null | undefined
    /** AND-joined property filters; see `SearchPropertyFilter`. */
    propertyFilters?: { key: string; value: string }[] | undefined
    /** AND-joined property exclusions. */
    excludedPropertyFilters?: { key: string; value: string }[] | undefined
    /**
     * `not-state:` projection. Backend emits
     * `(todo_state IS NULL OR todo_state NOT IN (...))` — NULL-inclusive
     * inversion. Literal `'none'` flips to `todo_state IS NOT NULL`.
     */
    excludedStateFilter?: string[] | undefined
    /** `not-priority:` projection. Symmetric to `excludedStateFilter`. */
    excludedPriorityFilter?: string[] | undefined
  },
  /**
   * Optional client-side abort. When the supplied
   * `AbortSignal` fires the returned promise rejects with a
   * `cancelled`-kind `AppError` (see {@link withAbort}), which
   * `isCancellation()` discriminates so superseded searches are
   * swallowed silently by the caller. The underlying IPC is NOT
   * cancelled server-side (Tauri 2 limitation); this is a
   * stop-waiting primitive that lets a newer search drop the prior
   * in-flight one. Omit for the pre-existing fire-and-forget shape.
   */
  signal?: AbortSignal,
): Promise<PageResponse<SearchBlockRow>> {
  return unwrap(
    await withAbort(
      commands.searchBlocks(params.query, params.cursor ?? null, params.limit ?? null, {
        parentId: params.parentId ?? null,
        tagIds: params.tagIds ?? [],
        scope: requireActiveScope(params.spaceId),
        includePageGlobs: params.includePageGlobs ?? [],
        excludePageGlobs: params.excludePageGlobs ?? [],
        caseSensitive: params.caseSensitive ?? false,
        wholeWord: params.wholeWord ?? false,
        isRegex: params.isRegex ?? false,
        blockTypeFilter: params.blockTypeFilter ?? null,
        stateFilter: params.stateFilter ?? [],
        priorityFilter: params.priorityFilter ?? [],
        dueFilter: marshalDateFilter(params.dueFilter ?? null),
        scheduledFilter: marshalDateFilter(params.scheduledFilter ?? null),
        propertyFilters: params.propertyFilters ?? [],
        excludedPropertyFilters: params.excludedPropertyFilters ?? [],
        excludedStateFilter: params.excludedStateFilter ?? [],
        excludedPriorityFilter: params.excludedPriorityFilter ?? [],
      }),
      signal,
    ),
  )
}

/**
 * Phase 1 — partitioned full-text search.
 *
 * Returns `pages` (rows where `block_type='page'`) and `blocks`
 * (unrestricted rank-ordered set; may include pages alongside content)
 * In **one** FTS5 scan. Replaces the palette pattern of firing
 * two parallel `searchBlocks` calls.
 *
 * `filter.blockTypeFilter` is ignored — the partitioning IS the
 * block-type split. The field stays on the wire for `SearchFilter` compat.
 */
export async function searchBlocksPartitioned(params: {
  query: string
  pageLimit: SafeLimit
  blockLimit: SafeLimit
  parentId?: string | undefined
  tagIds?: string[] | undefined
  spaceId: string
  includePageGlobs?: string[] | undefined
  excludePageGlobs?: string[] | undefined
  caseSensitive?: boolean | undefined
  wholeWord?: boolean | undefined
  isRegex?: boolean | undefined
  stateFilter?: string[] | undefined
  priorityFilter?: string[] | undefined
  dueFilter?: DateFilterValueInput | null | undefined
  scheduledFilter?: DateFilterValueInput | null | undefined
  propertyFilters?: { key: string; value: string }[] | undefined
  excludedPropertyFilters?: { key: string; value: string }[] | undefined
  excludedStateFilter?: string[] | undefined
  excludedPriorityFilter?: string[] | undefined
}): Promise<PartitionedSearchResponse> {
  return unwrap(
    await commands.searchBlocksPartitioned(params.query, params.pageLimit, params.blockLimit, {
      parentId: params.parentId ?? null,
      tagIds: params.tagIds ?? [],
      scope: requireActiveScope(params.spaceId),
      includePageGlobs: params.includePageGlobs ?? [],
      excludePageGlobs: params.excludePageGlobs ?? [],
      caseSensitive: params.caseSensitive ?? false,
      wholeWord: params.wholeWord ?? false,
      isRegex: params.isRegex ?? false,
      blockTypeFilter: null,
      stateFilter: params.stateFilter ?? [],
      priorityFilter: params.priorityFilter ?? [],
      dueFilter: marshalDateFilter(params.dueFilter ?? null),
      scheduledFilter: marshalDateFilter(params.scheduledFilter ?? null),
      propertyFilters: params.propertyFilters ?? [],
      excludedPropertyFilters: params.excludedPropertyFilters ?? [],
      excludedStateFilter: params.excludedStateFilter ?? [],
      excludedPriorityFilter: params.excludedPriorityFilter ?? [],
    }),
  )
}

/**
 * Frontend-side `DateFilter` input shape. Mirrors the
 * `DateFilterValue` union in `src/lib/search-query/types.ts` (the
 * shape the AST projection emits). The IPC wrapper translates this
 * to the wire shape (`DateFilter`) at the IPC boundary so the rest
 * of the frontend doesn't need to know about specta's `lt`/`lte`/…
 * string codes.
 */
export type DateFilterValueInput =
  | { kind: 'named'; name: string }
  | { kind: 'op'; op: '<' | '<=' | '=' | '>=' | '>'; date: string }

/** Translate a frontend `DateFilterValueInput` to the wire shape. */
function marshalDateFilter(
  v: DateFilterValueInput | null,
): import('@/lib/bindings').DateFilter | null {
  if (v == null) return null
  if (v.kind === 'named') {
    // The wire shape uses kebab-case for the `NamedDateRange` enum;
    // the input shape already matches.
    return { named: v.name as import('@/lib/bindings').NamedDateRange }
  }
  const opMap: Record<'<' | '<=' | '=' | '>=' | '>', import('@/lib/bindings').DateOp> = {
    '<': 'lt',
    '<=': 'lte',
    '=': 'eq',
    '>=': 'gte',
    '>': 'gt',
  }
  return { op: { op: opMap[v.op], date: v.date } }
}
