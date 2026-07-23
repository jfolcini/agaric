import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type {
  AdvancedQueryRequest,
  AdvancedQueryResponse,
  BlockRow,
  PageResponse,
} from '@/lib/bindings'
import type { SafeLimit } from '@/lib/safe-limit'
import { toSpaceScope } from '@/lib/tauri/_shared'

export interface ProjectedAgendaEntry {
  block: BlockRow
  projected_date: string
  source: string // 'due_date' | 'scheduled_date'
}
/**
 * #1280 — run a composable advanced query (boolean `FilterExpr` over the shared
 * filter vocabulary) against one space, returning a keyset-paginated page of
 * blocks. The backend gates every leaf against the advanced-query allowed-keys
 * set, bounds the tree depth, and binds every value as a parameter. Full-text,
 * grouping, and aggregation are added in follow-ups (the `score` channel on each
 * row is reserved for ranking).
 */
export async function runAdvancedQuery(
  request: AdvancedQueryRequest,
): Promise<AdvancedQueryResponse> {
  return unwrap(await commands.runAdvancedQuery(request))
}

/** List undated tasks (tasks with todo_state but no due/scheduled date).
 *
 * `spaceId` (Phase 4) — when set, restricts results to undated
 * tasks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped, matching the pre-
 * behaviour for cross-space callers.
 */
export async function listUndatedTasks(params?: {
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.listUndatedTasks(
      params?.cursor ?? null,
      params?.limit ?? null,
      toSpaceScope(params?.spaceId),
    ),
  )
}

/**
 * List projected future occurrences of repeating tasks for a date range.
 *
 * Cursor-paginated. Pass `cursor: response.next_cursor` to fetch
 * the next page; `has_more = false` indicates the final page.
 *
 * `spaceId` (Phase 4) — when set, restricts projections to
 * blocks whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the result set unscoped.
 */
export async function listProjectedAgenda(opts: {
  startDate: string
  endDate: string
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
}): Promise<PageResponse<ProjectedAgendaEntry>> {
  return unwrap(
    await commands.listProjectedAgenda(
      opts.startDate,
      opts.endDate,
      opts.cursor ?? null,
      opts.limit ?? null,
      toSpaceScope(opts.spaceId),
    ),
  )
}

/** Batch-count agenda items per date. Returns a map of date -> count.
 *
 * `spaceId` (Phase 4) — when set, restricts counts to agenda
 * items whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the counts cross-space.
 */
export async function countAgendaBatch(params: {
  dates: string[]
  spaceId?: string | null | undefined
}): Promise<Record<string, number>> {
  return unwrap(await commands.countAgendaBatch(params.dates, toSpaceScope(params.spaceId)))
}

/** Batch-count agenda items per (date, source). Returns nested map: date -> source -> count.
 *
 * `spaceId` (Phase 4) — when set, restricts counts to agenda
 * items whose owning page carries `space = <spaceId>`. `null` /
 * `undefined` leaves the counts cross-space.
 */
export async function countAgendaBatchBySource(params: {
  dates: string[]
  spaceId?: string | null | undefined
}): Promise<Record<string, Record<string, number>>> {
  return unwrap(await commands.countAgendaBatchBySource(params.dates, toSpaceScope(params.spaceId)))
}

/** Batch-count backlinks per target page. Returns a map of pageId -> count.
 *
 * `spaceId` — when set, restricts the counted source
 * blocks to those whose owning page carries `space = <spaceId>`.
 * `null` / `undefined` keeps the cross-space (legacy) behaviour. The
 * scope is forwarded as a [`SpaceScope`] via `toSpaceScope`. Without
 * this filter a page in space A could surface a non-zero badge count
 * whose source blocks live in space B — backlinks the user can't see.
 */
export async function countBacklinksBatch(params: {
  pageIds: string[]
  spaceId?: string | null | undefined
}): Promise<Record<string, number>> {
  return unwrap(await commands.countBacklinksBatch(params.pageIds, toSpaceScope(params.spaceId)))
}

/** Count soft-deleted blocks in a space. Used by the sidebar trash badge.
 *
 * The badge fetches the count via a `SELECT COUNT(*)` IPC so it stays
 * accurate regardless of trash size (limit-clamp follow-up).
 *
 * #2248 — the IPC takes the canonical `SpaceScope`; `spaceId` is a required
 * non-empty ULID wrapped into `{ kind: 'active', space_id }`. There is no
 * cross-space (`global`) trash count. In the pre-bootstrap window (no active
 * space) callers must short-circuit to `0` locally rather than pass `''`
 * (which now reaches the backend as a malformed `Active('')` and is rejected).
 */
export async function countTrash(spaceId: string): Promise<number> {
  return unwrap(await commands.countTrash(toSpaceScope(spaceId)))
}

// ---------------------------------------------------------------------------
// Block fixed-field commands (thin wrappers for reserved properties)
// ---------------------------------------------------------------------------

/** Query blocks by property key and optional value, with cursor pagination.
 *
 * `spaceId` (Phase 4) — when set, restricts matches to blocks
 * whose owning page carries `space = <spaceId>`. `null` / `undefined`
 * leaves the result set unscoped (cross-space view).
 */
export async function listUnfinishedTasks(params: {
  beforeDate: string
  todoStates: string[]
  cursor?: string
  limit?: SafeLimit
  spaceId?: string | null
}): Promise<PageResponse<BlockRow>> {
  return unwrap(
    await commands.listUnfinishedTasks(
      params.beforeDate,
      params.todoStates,
      params.cursor ?? null,
      params.limit ?? null,
      toSpaceScope(params.spaceId),
    ),
  )
}

/** Query blocks by property key/value with cursor pagination.
 *
 * `excludeParentId` / `contentNonEmpty` push the
 * DonePanel's two post-filters down into SQL so cursor pagination,
 * `total_count`, and load-more reflect the visible set instead of
 * the unfiltered raw page. `undefined` / `false` preserves the legacy
 * unfiltered behaviour.
 *
 * `blockType` / `valueTextIn` / `valueDateRange`
 * push three more filters into SQL:
 *  - `blockType` — equality on `b.block_type` (e.g. restrict templates
 *    to `'page'`).
 *  - `valueTextIn` — set-membership on `value_text`. Mutually
 *    exclusive with `valueText`; passing both is rejected by the
 *    backend.
 *  - `valueDateRange` — half-open `[from, to)` date range on
 *    `value_date` (or the matching reserved column for
 *    `due_date` / `scheduled_date`).
 *
 * On the IPC boundary all query params are marshalled into the single
 * Rust `QueryByPropertyRequest` DTO (#2277 item 7) — the intentional
 * per-command IPC request type. The flat public API is preserved here; the
 * `spaceId`-derived `SpaceScope` stays a separate argument.
 */
export async function queryByProperty(params: {
  key: string
  valueText?: string | undefined
  valueDate?: string | undefined
  operator?: string | undefined // 'eq', 'neq', 'lt', 'gt', 'lte', 'gte'
  cursor?: string | undefined
  limit?: SafeLimit | undefined
  spaceId?: string | null | undefined
  excludeParentId?: string | undefined
  contentNonEmpty?: boolean | undefined
  blockType?: string | undefined
  valueTextIn?: string[] | undefined
  valueDateRange?: [string, string] | undefined
  excludeTodoStates?: string[] | undefined
}): Promise<PageResponse<BlockRow>> {
  const request = {
    key: params.key,
    valueText: params.valueText ?? null,
    valueDate: params.valueDate ?? null,
    operator: params.operator ?? null,
    cursor: params.cursor ?? null,
    limit: params.limit ?? null,
    excludeParentId: params.excludeParentId ?? null,
    contentNonEmpty: params.contentNonEmpty ?? null,
    blockType: params.blockType ?? null,
    valueTextIn: params.valueTextIn ?? null,
    valueDateRange: params.valueDateRange ?? null,
    excludeTodoStates: params.excludeTodoStates ?? null,
  }
  return unwrap(await commands.queryByProperty(request, toSpaceScope(params.spaceId)))
}

/** Per-call property predicate accepted by [`filteredBlocksQuery`].
 *
 * Mirrors the Rust [`PropertyFilter`] struct shape (one EXISTS subquery
 * per filter). Distinct from the parser-side `PropertyFilter` in
 * `query-utils.ts` (which carries `{ key, value, operator }` for the
 * legacy fan-out shape) — the latter is translated into this shape at
 * the IPC boundary by `useQueryExecution`.
 */
export interface FilteredBlocksPropertyFilter {
  key: string
  valueText?: string | null
  valueTextIn?: string[]
  valueDate?: string | null
  valueDateRange?: [string, string] | null
  /** 'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte' (default: 'eq'). */
  operator?: string
}

/** Tag predicate accepted by [`filteredBlocksQuery`]. Mirrors the Rust
 *  [`TagFilterExpr`] struct.
 */
export interface FilteredBlocksTagFilter {
  tagIds?: string[]
  prefixes?: string[]
  /** 'and' for intersection, anything else (default 'or') for union. */
  mode?: string
  includeInherited?: boolean
}

/** AND-intersect property + tag predicates in SQL.
 *
 * Replaces the legacy `useQueryExecution.fetchFilteredQuery` shape that
 * fanned out one `queryByProperty` / `queryByTags` IPC per sub-filter
 * (each capped at 200 rows) and intersected the resulting block-id sets
 * in JS (capped at 50 rows). Any AND-set member outside the top-200 of
 * any one sub-query was silently dropped — the load-bearing regression
 * this command fixes.
 *
 * Each `propertyFilters[i]` becomes one `EXISTS (SELECT 1 FROM
 * block_properties …)` subquery composed into the parent SQL; the AND
 * across filters is the structural conjunction of those EXISTS clauses
 * (no JS post-filter, no per-sub-query row cap). `tagFilters` follows
 * the same shape (one `EXISTS` over `block_tags` / `block_tag_refs`
 * UNION). The composed query honours the page `cursor` / `limit` so
 * pagination walks the post-intersection set.
 *
 * At least one of `propertyFilters` / `tagFilters` / `blockType` must
 * be supplied — empty inputs are rejected with `Validation` so a
 * misconfigured caller surfaces loudly rather than silently scanning
 * every active block.
 */
export async function filteredBlocksQuery(params: {
  propertyFilters?: FilteredBlocksPropertyFilter[]
  tagFilters?: FilteredBlocksTagFilter | undefined
  blockType?: string | undefined
  spaceId?: string | null | undefined
  cursor?: string | undefined
  limit?: SafeLimit | undefined
}): Promise<PageResponse<BlockRow>> {
  // Marshal property filters into the camelCase Rust struct shape on
  // the IPC boundary. `valueTextIn` defaults to `[]` (matches the
  // Rust `#[serde(default)]` on `Vec<String>`); empty arrays are
  // semantically equivalent to "no IN-set predicate".
  const marshalledProps = (params.propertyFilters ?? []).map((pf) => ({
    key: pf.key,
    valueText: pf.valueText ?? null,
    valueTextIn: pf.valueTextIn ?? [],
    valueDate: pf.valueDate ?? null,
    valueDateRange: pf.valueDateRange ?? null,
    operator: pf.operator ?? 'eq',
  }))
  const marshalledTags = params.tagFilters
    ? {
        tagIds: params.tagFilters.tagIds ?? [],
        prefixes: params.tagFilters.prefixes ?? [],
        mode: params.tagFilters.mode ?? 'or',
        includeInherited: params.tagFilters.includeInherited ?? false,
      }
    : null
  return unwrap(
    await commands.filteredBlocksQuery(
      // The bindings.ts type uses an inline shape for PropertyFilter;
      // the marshalled object is structurally compatible.
      marshalledProps as Parameters<typeof commands.filteredBlocksQuery>[0],
      marshalledTags as Parameters<typeof commands.filteredBlocksQuery>[1],
      params.blockType ?? null,
      toSpaceScope(params.spaceId),
      params.cursor ?? null,
      params.limit ?? null,
    ),
  )
}

// ---------------------------------------------------------------------------
// Undo / Redo commands
// ---------------------------------------------------------------------------
